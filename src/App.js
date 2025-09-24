// src/App.js
import React, { useState } from "react";
import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { Pool, Position, nearestUsableTick } from "@uniswap/v3-sdk";
import JSBI from "jsbi";

const provider = new ethers.providers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

// Position Managers
const UNISWAP_PM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const CAMELOT_PM = "0x00c7f3082833e796A5b3e4Bd59f6642FF44DCD15";

// Factories
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const CAMELOT_FACTORY = "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B";

// ABIs
const UNI_PM_ABI = [
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256) view returns (address)"
];

// ✅ Camelot also uses struct-based collect
const CAM_PM_ABI = [
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) external returns (uint256 amount0,uint256 amount1)",
  "function ownerOf(uint256) view returns (address)"
];

const UNI_FACTORY_ABI = [
  "function getPool(address token0,address token1,uint24 fee) external view returns (address)"
];
const CAM_FACTORY_ABI = [
  "function poolByPair(address tokenA,address tokenB) external view returns (address pool)"
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function globalState() view returns (uint160 price,int24 tick,uint16,uint16,uint16,uint8,uint8,bool)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const MAX_UINT128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");

// ---------------- Helpers ----------------
async function fetchTokenMeta(address) {
  try {
    const c = new ethers.Contract(address, ERC20_ABI, provider);
    const [dec, sym] = await Promise.all([c.decimals(), c.symbol()]);
    return { decimals: Number(dec), symbol: sym };
  } catch {
    return { decimals: 18, symbol: "TKN" };
  }
}

async function getPoolAddress(token0, token1, fee, dex) {
  if (dex === "uniswap") {
    const factory = new ethers.Contract(UNISWAP_FACTORY, UNI_FACTORY_ABI, provider);
    return factory.getPool(token0, token1, fee);
  } else {
    const factory = new ethers.Contract(CAMELOT_FACTORY, CAM_FACTORY_ABI, provider);
    return factory.poolByPair(token0, token1);
  }
}

async function getPoolState(poolAddress, dex) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  if (dex === "uniswap") {
    const [slot0, liq, fee] = await Promise.all([pool.slot0(), pool.liquidity(), pool.fee()]);
    return { sqrtPriceX96: slot0.sqrtPriceX96.toString(), tick: slot0.tick, liquidity: liq.toString(), fee: Number(fee) };
  } else {
    const [state, liq] = await Promise.all([pool.globalState(), pool.liquidity()]);
    let fee = 500;
    try { fee = await pool.fee(); } catch {}
    return { sqrtPriceX96: state.price.toString(), tick: state.tick, liquidity: liq.toString(), fee: Number(fee) };
  }
}

function feeToTickSpacing(fee) {
  switch (Number(fee)) {
    case 500: return 10;
    case 3000: return 60;
    case 10000: return 200;
    default: return 60;
  }
}

/**
 * simulateCollect (works for both Uniswap + Camelot, both struct-based)
 */
async function simulateCollect(pm, nftId, dex) {
  try {
    const pmAbi = dex === "camelot" ? CAM_PM_ABI : UNI_PM_ABI;
    const contract = new ethers.Contract(pm, pmAbi, provider);

    const params = {
      tokenId: ethers.BigNumber.from(nftId),
      recipient: pm, // safe fallback
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128
    };

    const res = await contract.callStatic.collect(params);
    return [ethers.BigNumber.from(res.amount0), ethers.BigNumber.from(res.amount1)];
  } catch (err) {
    console.warn("simulateCollect failed:", err?.message ?? err);
    return [ethers.BigNumber.from(0), ethers.BigNumber.from(0)];
  }
}

// ---------------- React Component ----------------
function App() {
  const [dex, setDex] = useState("camelot");
  const [nftId, setNftId] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchPosition = async () => {
    setLoading(true);
    setResult(null);
    try {
      if (nftId === "") throw new Error("Please provide an NFT ID");

      const pm = dex === "camelot" ? CAMELOT_PM : UNISWAP_PM;
      const pmAbi = dex === "camelot" ? CAM_PM_ABI : UNI_PM_ABI;
      const contract = new ethers.Contract(pm, pmAbi, provider);

      const pos = await contract.positions(nftId);

      const token0Addr = pos.token0;
      const token1Addr = pos.token1;
      if (!token0Addr || !token1Addr || token0Addr === ethers.constants.AddressZero) {
        throw new Error("Invalid position (missing tokens)");
      }

      const tickLower = Number(pos.tickLower);
      const tickUpper = Number(pos.tickUpper);
      const liquidity = pos.liquidity ? pos.liquidity.toString() : "0";
      const fee = pos.fee ? Number(pos.fee) : 3000;

      const tokensOwed0BN = pos.tokensOwed0 ? ethers.BigNumber.from(pos.tokensOwed0) : ethers.BigNumber.from(0);
      const tokensOwed1BN = pos.tokensOwed1 ? ethers.BigNumber.from(pos.tokensOwed1) : ethers.BigNumber.from(0);

      const poolAddr = await getPoolAddress(token0Addr, token1Addr, fee, dex);
      if (!poolAddr || poolAddr === ethers.constants.AddressZero) throw new Error("Pool not found");
      const state = await getPoolState(poolAddr, dex);

      const t0 = await fetchTokenMeta(token0Addr);
      const t1 = await fetchTokenMeta(token1Addr);

      const token0 = new Token(42161, token0Addr, t0.decimals, t0.symbol);
      const token1 = new Token(42161, token1Addr, t1.decimals, t1.symbol);

      const tickSpacing = feeToTickSpacing(state.fee || fee);
      const usableTickLower = nearestUsableTick(tickLower, tickSpacing);
      const usableTickUpper = nearestUsableTick(tickUpper, tickSpacing);

      const pool = new Pool(
        token0,
        token1,
        state.fee,
        state.sqrtPriceX96,
        state.liquidity,
        state.tick
      );

      const position = new Position({
        pool,
        liquidity: JSBI.BigInt(liquidity),
        tickLower: usableTickLower,
        tickUpper: usableTickUpper
      });

      const withdraw0 = parseFloat(position.amount0.toSignificant(12));
      const withdraw1 = parseFloat(position.amount1.toSignificant(12));

      const [fee0Raw, fee1Raw] = await simulateCollect(pm, nftId, dex);
      const fee0 = parseFloat(ethers.utils.formatUnits(fee0Raw, t0.decimals));
      const fee1 = parseFloat(ethers.utils.formatUnits(fee1Raw, t1.decimals));

      const owed0 = parseFloat(ethers.utils.formatUnits(tokensOwed0BN, t0.decimals));
      const owed1 = parseFloat(ethers.utils.formatUnits(tokensOwed1BN, t1.decimals));

      const currentTick = Number(state.tick);
      const inRange = currentTick >= usableTickLower && currentTick <= usableTickUpper;

      const totalClaimable0 = withdraw0 + fee0;
      const totalClaimable1 = withdraw1 + fee1;

      setResult({
        dex,
        pm,
        poolAddress: poolAddr,
        token0: { symbol: t0.symbol, address: token0Addr },
        token1: { symbol: t1.symbol, address: token1Addr },
        withdrawable: { amount0: withdraw0, amount1: withdraw1 },
        simulatedUncollected: { amount0: fee0, amount1: fee1 },
        onchainTokensOwed: { amount0: owed0, amount1: owed1 },
        totalClaimable: { amount0: totalClaimable0, amount1: totalClaimable1 },
        liquidity,
        poolTick: currentTick,
        usableTickLower,
        usableTickUpper,
        inRange
      });
    } catch (err) {
      console.error(err);
      setResult({ error: err?.message ?? String(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: "monospace" }}>
      <h2>DEX Position Viewer (Arbitrum)</h2>

      <div style={{ marginBottom: 12 }}>
        <label>
          DEX:{" "}
          <select value={dex} onChange={(e) => setDex(e.target.value)}>
            <option value="camelot">Camelot V3</option>
            <option value="uniswap">Uniswap V3</option>
          </select>
        </label>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input
          placeholder="NFT ID"
          value={nftId}
          onChange={(e) => setNftId(e.target.value)}
          style={{ padding: 8, width: 200 }}
        />
        <button onClick={fetchPosition} style={{ marginLeft: 8, padding: "8px 12px" }}>
          {loading ? "Fetching..." : "Fetch Position"}
        </button>
      </div>

      {result && result.error && (
        <div style={{ color: "crimson" }}>
          <b>Error:</b> {result.error}
        </div>
      )}

      {result && !result.error && (
        <div style={{ whiteSpace: "pre-wrap" }}>
          <h3>Position Summary</h3>
          <div><b>DEX:</b> {result.dex}</div>
          <div><b>Position Manager:</b> {result.pm}</div>
          <div><b>Pool:</b> {result.poolAddress}</div>
          <hr />

          <div>
            <b>{result.token0.symbol}</b> — {result.token0.address}
            <div>Withdrawable: {result.withdrawable.amount0} {result.token0.symbol}</div>
            <div>Simulated uncollected fees: {result.simulatedUncollected.amount0} {result.token0.symbol}</div>
            <div>On-chain tokensOwed: {result.onchainTokensOwed.amount0} {result.token0.symbol}</div>
            <div><b>Total claimable: {result.totalClaimable.amount0} {result.token0.symbol}</b></div>
          </div>

          <div style={{ marginTop: 12 }}>
            <b>{result.token1.symbol}</b> — {result.token1.address}
            <div>Withdrawable: {result.withdrawable.amount1} {result.token1.symbol}</div>
            <div>Simulated uncollected fees: {result.simulatedUncollected.amount1} {result.token1.symbol}</div>
            <div>On-chain tokensOwed: {result.onchainTokensOwed.amount1} {result.token1.symbol}</div>
            <div><b>Total claimable: {result.totalClaimable.amount1} {result.token1.symbol}</b></div>
          </div>

          <hr />
          <div><b>Liquidity:</b> {result.liquidity}</div>
          <div><b>Pool tick:</b> {result.poolTick}</div>
          <div><b>Usable ticks:</b> {result.usableTickLower} — {result.usableTickUpper}</div>
          <div style={{ color: result.inRange ? "green" : "orange" }}>
            <b>Position in-range:</b> {String(result.inRange)}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
