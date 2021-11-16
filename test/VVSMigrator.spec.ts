import chai, { expect } from 'chai'
import { BigNumber, Contract, constants } from 'ethers'
const { AddressZero, MaxUint256 } = constants
import { solidity, MockProvider } from 'ethereum-waffle'

import { v2Fixture } from './shared/fixtures'
import { expandTo18Decimals, MINIMUM_LIQUIDITY } from './shared/utilities'

chai.use(solidity)

const overrides = {
  gasLimit: 9999999
}

describe('VVSMigrator', () => {
  const provider = new MockProvider({ganacheOptions: {
    hardfork: 'istanbul',
    mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
    gasLimit: 9999999
  }})
  const [wallet] = provider.getWallets()

  let WETHPartner: Contract
  let WETHPair: Contract
  let router: Contract
  let migrator: Contract
  let WETHExchangeV1: Contract
  beforeEach(async function() {
    const fixture = await v2Fixture(provider, [wallet])
    WETHPartner = fixture.WETHPartner
    WETHPair = fixture.WETHPair
    router = fixture.router01 // we used router01 for this contract
    migrator = fixture.migrator
    WETHExchangeV1 = fixture.WETHExchangeV1
  })

  it('migrate', async () => {
    const WETHPartnerAmount = expandTo18Decimals(1)
    const ETHAmount = expandTo18Decimals(4)
    await WETHPartner.approve(WETHExchangeV1.address, MaxUint256)
    await WETHExchangeV1.addLiquidity(BigNumber.from(1), WETHPartnerAmount, MaxUint256, {
      ...overrides,
      value: ETHAmount
    })
    await WETHExchangeV1.approve(migrator.address, MaxUint256)
    const expectedLiquidity = expandTo18Decimals(2)
    const WETHPairToken0 = await WETHPair.token0()
    await expect(
      migrator.migrate(WETHPartner.address, WETHPartnerAmount, ETHAmount, wallet.address, MaxUint256, overrides)
    )
      .to.emit(WETHPair, 'Transfer')
      .withArgs(AddressZero, AddressZero, MINIMUM_LIQUIDITY)
      .to.emit(WETHPair, 'Transfer')
      .withArgs(AddressZero, wallet.address, expectedLiquidity.sub(MINIMUM_LIQUIDITY))
      .to.emit(WETHPair, 'Sync')
      .withArgs(
        WETHPairToken0 === WETHPartner.address ? WETHPartnerAmount : ETHAmount,
        WETHPairToken0 === WETHPartner.address ? ETHAmount : WETHPartnerAmount
      )
      .to.emit(WETHPair, 'Mint')
      .withArgs(
        router.address,
        WETHPairToken0 === WETHPartner.address ? WETHPartnerAmount : ETHAmount,
        WETHPairToken0 === WETHPartner.address ? ETHAmount : WETHPartnerAmount
      )
    expect(await WETHPair.balanceOf(wallet.address)).to.eq(expectedLiquidity.sub(MINIMUM_LIQUIDITY))
  })
})
