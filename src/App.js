// src/App.js
import React, { useState } from "react";
import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
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
  "function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)"
];

const CAM_PM_ABI = [
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) external returns (uint256 amount0,uint256 amount1)"
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

async function simulateCollect(pm, nftId, dex) {
  try {
    const pmAbi = dex === "camelot" ? CAM_PM_ABI : UNI_PM_ABI;
    const contract = new ethers.Contract(pm, pmAbi, provider);

    if (dex === "uniswap") {
      const result = await contract.callStatic.collect({
        tokenId: nftId,
        recipient: ethers.constants.AddressZero,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128
      });
      return [ethers.BigNumber.from(result.amount0), ethers.BigNumber.from(result.amount1)];
    } else {
      const result = await contract.callStatic.collect(
        nftId,
        ethers.constants.AddressZero,
        MAX_UINT128,
        MAX_UINT128
      );
      return [ethers.BigNumber.from(result[0]), ethers.BigNumber.from(result[1])];
    }
  } catch (err) {
    console.warn("simulateCollect failed:", err.message);
    return [ethers.BigNumber.from(0), ethers.BigNumber.from(0)];
  }
}

// ---------------- React Component ----------------
function App() {
  const [dex, setDex] = useState("camelot");
  const [nftId, setNftId] = useState("");
  const [result, setResult] = useState(null);

  const fetchPosition = async () => {
    try {
      const pm = dex === "camelot" ? CAMELOT_PM : UNISWAP_PM;
      const pmAbi = dex === "camelot" ? CAM_PM_ABI : UNI_PM_ABI;
      const contract = new ethers.Contract(pm, pmAbi, provider);

      const pos = await contract.positions(nftId);
      const token0Addr = pos.token0;
      const token1Addr = pos.token1;

      if (!token0Addr || !token1Addr || token0Addr === ethers.constants.AddressZero) {
        throw new Error("Invalid position");
      }

      const tickLower = Number(pos.tickLower);
      const tickUpper = Number(pos.tickUpper);
      const liquidity = pos.liquidity.toString();
      const fee = pos.fee ? Number(pos.fee) : 3000;

      const poolAddr = await getPoolAddress(token0Addr, token1Addr, fee, dex);
      if (!poolAddr || poolAddr === ethers.constants.AddressZero) throw new Error("Pool not found");

      const state = await getPoolState(poolAddr, dex);
      const t0 = await fetchTokenMeta(token0Addr);
      const t1 = await fetchTokenMeta(token1Addr);

      const token0 = new Token(42161, token0Addr, t0.decimals, t0.symbol);
      const token1 = new Token(42161, token1Addr, t1.decimals, t1.symbol);

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
        tickLower,
        tickUpper
      });

      const withdraw0 = position.amount0.toSignificant(6);
      const withdraw1 = position.amount1.toSignificant(6);

      const [fee0Raw, fee1Raw] = await simulateCollect(pm, nftId, dex);
      const fee0 = parseFloat(ethers.utils.formatUnits(fee0Raw, t0.decimals));
      const fee1 = parseFloat(ethers.utils.formatUnits(fee1Raw, t1.decimals));

      setResult({
        dex,
        poolAddress: poolAddr,
        token0: `${t0.symbol} (${token0Addr})`,
        token1: `${t1.symbol} (${token1Addr})`,
        withdrawable: { amount0: withdraw0, amount1: withdraw1 },
        uncollectedFees: { fee0, fee1 },
        liquidity
      });
    } catch (err) {
      console.error(err);
      setResult({ error: err.message });
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: "monospace" }}>
      <h2>DEX Position Viewer</h2>
      <select value={dex} onChange={(e) => setDex(e.target.value)}>
        <option value="camelot">Camelot V3</option>
        <option value="uniswap">Uniswap V3</option>
      </select>
      <br /><br />
      <input
        placeholder="NFT ID"
        value={nftId}
        onChange={(e) => setNftId(e.target.value)}
      />
      <button onClick={fetchPosition}>Fetch Position</button>
      <br /><br />
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

export default App;
