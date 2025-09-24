async calculateUserAPR(orderbooks: OrderBook[]): Promise<{positionIdToApr: Map<string, number>, totalDollarValue: number, averageAPR: number, totalInvestmentValue: number, dailyReturnAPY: number, dailyReturn: number, positionIdToTotalSizeOfPosition: Map<string, number>}> {
  //TODO: Implement APR calculation
  //Params
  let totalInvestmentValue = 0;
  let totalFeesEarned = 0;
  let totalPercentage = 0;
  let dailyReturnReward = 0;
  let dailyReturnInDollars = 0;
  let PositionToSkip = 0;
  //PositionId mapped with their apr
  let positionIdToApr: Map<string, number> = new Map();
  let positionIdToTotalSizeOfPosition: Map<string, number> = new Map();
  
  console.log(`\n=== Calculating APR for ${orderbooks.length} positions ===`);
  
  for(const orderBook of orderbooks){
    console.log(`\n--- Processing position ${orderBook.position_id} ---`);
    console.log(`Position active status: ${orderBook.is_active}`);
    console.log(`Position risk profile: ${orderBook.risk_profile}`);
    const poolInfo = await this.getPoolInfo(orderBook.chain, orderBook.pool_address, orderBook.metadata.dexName);

    const { amount0Desired, amount1Desired } = await this.calculateOptimalAmounts(
      orderBook.chain,
      orderBook.pool_address,
      Number(orderBook.upper_ticks),
      Number(orderBook.lower_ticks),
      orderBook.metadata.liquidity,
      orderBook.metadata.token0Address,
      orderBook.metadata.token1Address,
      orderBook.token0_decimals,
      orderBook.token1_decimals,
      poolInfo
    );
    //Get the fee0 and fee1 from the orderbook - that is already collected by the user:
    const collectedFee0 = orderBook.metadata.fee0;
    const collectedFee1 = orderBook.metadata.fee1;
    console.log("Collected fee0: ",collectedFee0, "Collected fee1: ",collectedFee1)
    let accumulatedAmount0 = 0;
    let accumulatedAmount1 = 0;

    //Simulating collect fees for the position
    try{

    const { result: simResult } = await simulateContract(this.wagmiConfig, {
      address: orderBook.metadata.positionManager as `0x${string}`, // pos.vault.positionManager
      abi: ALJEBRA_POSITION_NFT_V1,       // Same ABI as frontend
      functionName: 'collect',
      args: [{
        tokenId: BigInt(orderBook.metadata?.nftId),
        recipient: orderBook.metadata.credit_account_address    ,
        amount0Max: BigInt(2n ** 128n - 1n),
        amount1Max: BigInt(2n ** 128n - 1n)
      }],
      
      account: orderBook.metadata.credit_account_address as `0x${string}`,          // creditAccountsList[0] equivalent
      chainId: this.getChainConfig(orderBook.chain).chainId as any
    }) as any;
    accumulatedAmount0 = simResult[0];
    accumulatedAmount1 = simResult[1];
    console.log("Accumulated amount0: ",accumulatedAmount0, "Accumulated amount1: ",accumulatedAmount1)
  }
  catch(error){
    console.error("Error in simulateContract: ",error)
    //Skip the position if there is an error in simulateContract
    //Disable orderBook in the database
    await this.orderBookService.updateOrderBook(orderBook.id, {is_active: false});
    PositionToSkip++
    continue;
  }

    const accumulatedAmount0Human = ethers.formatUnits(accumulatedAmount0.toString(), orderBook.token0_decimals);
    const accumulatedAmount1Human = ethers.formatUnits(accumulatedAmount1.toString(), orderBook.token1_decimals);

    console.log("Collect fees result: human ",accumulatedAmount0Human, accumulatedAmount1Human)

    // Calculate total fees and convert to USD accumulated and amount
    // Fetch prices using the token symbols directly - mapping is handled in marketDataService
    const token0Price = await this.marketDataService.fetchCurrentPrice(orderBook.metadata.token0Symbol);
    const token1Price = await this.marketDataService.fetchCurrentPrice(orderBook.metadata.token1Symbol);
    console.log("Token0 price: ",token0Price, "Token1 price: ",token1Price)
    
    // Convert collected fees from wei to human readable format
    const collectedFee0Human = ethers.formatUnits(collectedFee0 || "0", orderBook.token0_decimals);
    const collectedFee1Human = ethers.formatUnits(collectedFee1 || "0", orderBook.token1_decimals);
    
    const totalFeesUSD = (parseFloat(accumulatedAmount0Human) * token0Price) + (parseFloat(accumulatedAmount1Human) * token1Price);
    const totalCollectedFeesUSD = (parseFloat(collectedFee0Human) * token0Price) + (parseFloat(collectedFee1Human) * token1Price);
    console.log("Total Collected Fees in token0 and token1 individually (human readable): ",collectedFee0Human, collectedFee1Human)
    const totalAccumulatedFeesUSD = totalFeesUSD + totalCollectedFeesUSD;
    console.log("Total fees in USD: ",totalAccumulatedFeesUSD)

    //Invested amount in USD
    const investedAmountUSD = (parseFloat(amount0Desired) * token0Price) + (parseFloat(amount1Desired) * token1Price);
    console.log("Invested amount in USD: ",investedAmountUSD)
    // Add collected and uncollected fees to get total fee0 and fee1.
    // Convert the total to USD using current token prices.
    // Fetch the position creation timestamp
    // Get the position's createdAt time from the subgraph.
    const createdAt = orderBook.metadata.createdAt;
    console.log("Position createdAt timestamp:", createdAt);
    console.log("Position createdAt date:", new Date(createdAt * 1000).toISOString());
    
    // Compute APY
    // First, calculate the position's age in seconds:
    const currentTimestamp = Date.now() / 1000;
    console.log("Current timestamp:", currentTimestamp);
    console.log("Current date:", new Date(currentTimestamp * 1000).toISOString());
    
    const durationInSeconds = currentTimestamp - createdAt;
    const durationInDays = durationInSeconds / (24 * 60 * 60);
    console.log("Duration in seconds:", durationInSeconds);
    console.log("Duration in days:", durationInDays);
    //  durationInSeconds = currentTimestamp - createdAtTimestamp
    // Calculate Per-Second APY:
    //  perSecondAPY = (totalEarningsUSD / investedAmountUSD) / durationInSeconds
    const perSecondAPY = (totalAccumulatedFeesUSD / investedAmountUSD) / durationInSeconds;
    // Calculate Annualized APY:
    //  yearlyAPY = perSecondAPY * 31,536,000 (seconds in a year)
    const yearlyAPY = perSecondAPY * 31536000;
    
    // Manual verification
    const dailyReturn = totalAccumulatedFeesUSD / investedAmountUSD / durationInDays;
    const dailyReturnInDollarsinPosition = totalAccumulatedFeesUSD / durationInDays;
    const annualizedAPR = dailyReturn * 365;
    
    console.log("=== APR Calculation Verification ===");
    console.log("Fees earned:", totalAccumulatedFeesUSD);
    console.log("Investment:", investedAmountUSD);
    console.log("Daily return rate:", (dailyReturn * 100).toFixed(4) + "%");
    console.log("Annualized APR (manual):", (annualizedAPR * 100).toFixed(2) + "%");
    console.log("Yearly APY (formula):", (yearlyAPY * 100).toFixed(2) + "%");
    console.log("=====================================");
    //Return the yearly APY as percentage (multiply by 100)
    positionIdToApr.set(orderBook.position_id, yearlyAPY * 100);
    positionIdToTotalSizeOfPosition.set(orderBook.position_id, investedAmountUSD);
    totalInvestmentValue += investedAmountUSD;
    totalFeesEarned += totalAccumulatedFeesUSD;
    totalPercentage += yearlyAPY * 100; // Store as percentage
    dailyReturnReward += dailyReturn;
    dailyReturnInDollars += dailyReturnInDollarsinPosition;

  }
  const averageAPR = totalPercentage / (orderbooks.length - PositionToSkip);
  const totalPortfolioValue = totalInvestmentValue + totalFeesEarned;
  
  console.log("Average APR: ",averageAPR)
  console.log("Total Investment Value: ",totalInvestmentValue)
  console.log("Total Fees Earned: ",totalFeesEarned) 
  console.log("Total Portfolio Value: ",totalPortfolioValue)
  
  return {
    positionIdToApr: positionIdToApr,
    totalDollarValue: totalPortfolioValue, // This is investment + fees

    
    averageAPR: averageAPR,
    totalInvestmentValue: totalInvestmentValue,
    dailyReturnAPY: dailyReturnReward,
    dailyReturn: dailyReturnInDollars, 
    positionIdToTotalSizeOfPosition: positionIdToTotalSizeOfPosition,


  }
   



