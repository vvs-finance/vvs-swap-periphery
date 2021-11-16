import chai, { expect } from 'chai'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'
import { Contract, BigNumber, constants } from 'ethers'
const {  MaxUint256 } = constants
import IVVSPair from '../build/IVVSPair.json'

import { v2Fixture } from './shared/fixtures'
import { expandTo18Decimals, getApprovalDigest, MINIMUM_LIQUIDITY } from './shared/utilities'

import DeflatingERC20 from '../build/DeflatingERC20.json'
import { ecsign } from 'ethereumjs-util'

chai.use(solidity)

const overrides = {
  gasLimit: 9999999
}

describe('VVSRouter', () => {
  const provider = new MockProvider({ganacheOptions: {
    hardfork: 'istanbul',
    mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
    gasLimit: 9999999
  }})
  const [wallet] = provider.getWallets()

  let token0: Contract
  let token1: Contract
  let router: Contract
  beforeEach(async function() {
    const fixture = await v2Fixture(provider, [wallet])
    token0 = fixture.token0
    token1 = fixture.token1
    router = fixture.router02
  })

  it('quote', async () => {
    expect(await router.quote(BigNumber.from(1), BigNumber.from(100), BigNumber.from(200))).to.eq(BigNumber.from(2))
    expect(await router.quote(BigNumber.from(2), BigNumber.from(200), BigNumber.from(100))).to.eq(BigNumber.from(1))
    await expect(router.quote(BigNumber.from(0), BigNumber.from(100), BigNumber.from(200))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_AMOUNT'
    )
    await expect(router.quote(BigNumber.from(1), BigNumber.from(0), BigNumber.from(200))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
    await expect(router.quote(BigNumber.from(1), BigNumber.from(100), BigNumber.from(0))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
  })

  it('getAmountOut', async () => {
    expect(await router.getAmountOut(BigNumber.from(2), BigNumber.from(100), BigNumber.from(100))).to.eq(BigNumber.from(1))
    await expect(router.getAmountOut(BigNumber.from(0), BigNumber.from(100), BigNumber.from(100))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_INPUT_AMOUNT'
    )
    await expect(router.getAmountOut(BigNumber.from(2), BigNumber.from(0), BigNumber.from(100))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
    await expect(router.getAmountOut(BigNumber.from(2), BigNumber.from(100), BigNumber.from(0))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
  })

  it('getAmountIn', async () => {
    expect(await router.getAmountIn(BigNumber.from(1), BigNumber.from(100), BigNumber.from(100))).to.eq(BigNumber.from(2))
    await expect(router.getAmountIn(BigNumber.from(0), BigNumber.from(100), BigNumber.from(100))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_OUTPUT_AMOUNT'
    )
    await expect(router.getAmountIn(BigNumber.from(1), BigNumber.from(0), BigNumber.from(100))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
    await expect(router.getAmountIn(BigNumber.from(1), BigNumber.from(100), BigNumber.from(0))).to.be.revertedWith(
      'VVSLibrary: INSUFFICIENT_LIQUIDITY'
    )
  })

  it('getAmountsOut', async () => {
    await token0.approve(router.address, MaxUint256)
    await token1.approve(router.address, MaxUint256)
    await router.addLiquidity(
      token0.address,
      token1.address,
      BigNumber.from(10000),
      BigNumber.from(10000),
      0,
      0,
      wallet.address,
      MaxUint256,
      overrides
    )

    await expect(router.getAmountsOut(BigNumber.from(2), [token0.address])).to.be.revertedWith('VVSLibrary: INVALID_PATH')
    const path = [token0.address, token1.address]
    expect(await router.getAmountsOut(BigNumber.from(2), path)).to.deep.eq([BigNumber.from(2), BigNumber.from(1)])
  })

  it('getAmountsIn', async () => {
    await token0.approve(router.address, MaxUint256)
    await token1.approve(router.address, MaxUint256)
    await router.addLiquidity(
      token0.address,
      token1.address,
      BigNumber.from(10000),
      BigNumber.from(10000),
      0,
      0,
      wallet.address,
      MaxUint256,
      overrides
    )

    await expect(router.getAmountsIn(BigNumber.from(1), [token0.address])).to.be.revertedWith('VVSLibrary: INVALID_PATH')
    const path = [token0.address, token1.address]
    expect(await router.getAmountsIn(BigNumber.from(1), path)).to.deep.eq([BigNumber.from(2), BigNumber.from(1)])
  })

  describe('fee-on-transfer tokens', () => {
    let DTT: Contract
    let WETH: Contract
    let router: Contract
    let pair: Contract
    beforeEach(async function() {
      const fixture = await v2Fixture(provider, [wallet])

      WETH = fixture.WETH
      router = fixture.router02

      DTT = await deployContract(wallet, DeflatingERC20, [expandTo18Decimals(10000)])

      // make a DTT<>WETH pair
      await fixture.factoryV2.createPair(DTT.address, WETH.address)
      const pairAddress = await fixture.factoryV2.getPair(DTT.address, WETH.address)
      pair = new Contract(pairAddress, JSON.stringify(IVVSPair.abi), provider).connect(wallet)
    })

    afterEach(async function() {
      expect(await provider.getBalance(router.address)).to.eq(0)
    })

    async function addLiquidity(DTTAmount: BigNumber, WETHAmount: BigNumber) {
      await DTT.approve(router.address, MaxUint256)
      await router.addLiquidityETH(DTT.address, DTTAmount, DTTAmount, WETHAmount, wallet.address, MaxUint256, {
        ...overrides,
        value: WETHAmount
      })
    }

    it('removeLiquidityETHSupportingFeeOnTransferTokens', async () => {
      const DTTAmount = expandTo18Decimals(1)
      const ETHAmount = expandTo18Decimals(4)
      await addLiquidity(DTTAmount, ETHAmount)

      const DTTInPair = await DTT.balanceOf(pair.address)
      const WETHInPair = await WETH.balanceOf(pair.address)
      const liquidity = await pair.balanceOf(wallet.address)
      const totalSupply = await pair.totalSupply()
      const NaiveDTTExpected = DTTInPair.mul(liquidity).div(totalSupply)
      const WETHExpected = WETHInPair.mul(liquidity).div(totalSupply)

      await pair.approve(router.address, MaxUint256)
      await router.removeLiquidityETHSupportingFeeOnTransferTokens(
        DTT.address,
        liquidity,
        NaiveDTTExpected,
        WETHExpected,
        wallet.address,
        MaxUint256,
        overrides
      )
    })

    it('removeLiquidityETHWithPermitSupportingFeeOnTransferTokens', async () => {
      const DTTAmount = expandTo18Decimals(1)
        .mul(100)
        .div(99)
      const ETHAmount = expandTo18Decimals(4)
      await addLiquidity(DTTAmount, ETHAmount)

      const expectedLiquidity = expandTo18Decimals(2)

      const nonce = await pair.nonces(wallet.address)
      const digest = await getApprovalDigest(
        pair,
        { owner: wallet.address, spender: router.address, value: expectedLiquidity.sub(MINIMUM_LIQUIDITY) },
        nonce,
        MaxUint256
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      const DTTInPair = await DTT.balanceOf(pair.address)
      const WETHInPair = await WETH.balanceOf(pair.address)
      const liquidity = await pair.balanceOf(wallet.address)
      const totalSupply = await pair.totalSupply()
      const NaiveDTTExpected = DTTInPair.mul(liquidity).div(totalSupply)
      const WETHExpected = WETHInPair.mul(liquidity).div(totalSupply)

      await pair.approve(router.address, MaxUint256)
      await router.removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        DTT.address,
        liquidity,
        NaiveDTTExpected,
        WETHExpected,
        wallet.address,
        MaxUint256,
        false,
        v,
        r,
        s,
        overrides
      )
    })

    describe('swapExactTokensForTokensSupportingFeeOnTransferTokens', () => {
      const DTTAmount = expandTo18Decimals(5)
        .mul(100)
        .div(99)
      const ETHAmount = expandTo18Decimals(10)
      const amountIn = expandTo18Decimals(1)

      beforeEach(async () => {
        await addLiquidity(DTTAmount, ETHAmount)
      })

      it('DTT -> WETH', async () => {
        await DTT.approve(router.address, MaxUint256)

        await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          0,
          [DTT.address, WETH.address],
          wallet.address,
          MaxUint256,
          overrides
        )
      })

      // WETH -> DTT
      it('WETH -> DTT', async () => {
        await WETH.deposit({ value: amountIn }) // mint WETH
        await WETH.approve(router.address, MaxUint256)

        await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          0,
          [WETH.address, DTT.address],
          wallet.address,
          MaxUint256,
          overrides
        )
      })
    })

    // ETH -> DTT
    it('swapExactETHForTokensSupportingFeeOnTransferTokens', async () => {
      const DTTAmount = expandTo18Decimals(10)
        .mul(100)
        .div(99)
      const ETHAmount = expandTo18Decimals(5)
      const swapAmount = expandTo18Decimals(1)
      await addLiquidity(DTTAmount, ETHAmount)

      await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WETH.address, DTT.address],
        wallet.address,
        MaxUint256,
        {
          ...overrides,
          value: swapAmount
        }
      )
    })

    // DTT -> ETH
    it('swapExactTokensForETHSupportingFeeOnTransferTokens', async () => {
      const DTTAmount = expandTo18Decimals(5)
        .mul(100)
        .div(99)
      const ETHAmount = expandTo18Decimals(10)
      const swapAmount = expandTo18Decimals(1)

      await addLiquidity(DTTAmount, ETHAmount)
      await DTT.approve(router.address, MaxUint256)

      await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        swapAmount,
        0,
        [DTT.address, WETH.address],
        wallet.address,
        MaxUint256,
        overrides
      )
    })
  })

  describe('fee-on-transfer tokens: reloaded', () => {
    let DTT: Contract
    let DTT2: Contract
    let router: Contract
    beforeEach(async function() {
      const fixture = await v2Fixture(provider, [wallet])

      router = fixture.router02

      DTT = await deployContract(wallet, DeflatingERC20, [expandTo18Decimals(10000)])
      DTT2 = await deployContract(wallet, DeflatingERC20, [expandTo18Decimals(10000)])

      // make a DTT<>WETH pair
      await fixture.factoryV2.createPair(DTT.address, DTT2.address)
      const pairAddress = await fixture.factoryV2.getPair(DTT.address, DTT2.address)
    })

    afterEach(async function() {
      expect(await provider.getBalance(router.address)).to.eq(0)
    })

    async function addLiquidity(DTTAmount: BigNumber, DTT2Amount: BigNumber) {
      await DTT.approve(router.address, MaxUint256)
      await DTT2.approve(router.address, MaxUint256)
      await router.addLiquidity(
        DTT.address,
        DTT2.address,
        DTTAmount,
        DTT2Amount,
        DTTAmount,
        DTT2Amount,
        wallet.address,
        MaxUint256,
        overrides
      )
    }

    describe('swapExactTokensForTokensSupportingFeeOnTransferTokens', () => {
      const DTTAmount = expandTo18Decimals(5)
        .mul(100)
        .div(99)
      const DTT2Amount = expandTo18Decimals(5)
      const amountIn = expandTo18Decimals(1)

      beforeEach(async () => {
        await addLiquidity(DTTAmount, DTT2Amount)
      })

      it('DTT -> DTT2', async () => {
        await DTT.approve(router.address, MaxUint256)

        await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          0,
          [DTT.address, DTT2.address],
          wallet.address,
          MaxUint256,
          overrides
        )
      })
    })
  })

})
