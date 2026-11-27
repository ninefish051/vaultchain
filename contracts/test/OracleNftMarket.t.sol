// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {CardPriceOracle} from "../src/CardPriceOracle.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";
import {VaultMarket} from "../src/VaultMarket.sol";

contract OracleTest is Base {
    function test_submitPrice_byAnyRelayer() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        CardPriceOracle.PricePoint memory p = _pricePoint(5_200e6, 900);
        bytes memory sig = _signPrice(signerPk, CARD, p);
        vm.prank(makeAddr("anyone"));
        oracle.submitPrice(CARD, p, sig);
        CardPriceOracle.PricePoint memory got = oracle.getPrice(CARD);
        assertEq(got.fairValueUsd, 5_200e6);
        assertEq(got.volatilityBps, 900);
    }

    function test_submitPrice_rejectsUnknownSigner() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        CardPriceOracle.PricePoint memory p = _pricePoint(5_200e6, 900);
        bytes memory sig = _signPrice(0xBAD, CARD, p);
        vm.expectRevert(abi.encodeWithSelector(CardPriceOracle.InvalidSigner.selector, vm.addr(0xBAD)));
        oracle.submitPrice(CARD, p, sig);
    }

    function test_submitPrice_rejectsReplayAndOldData() public {
        CardPriceOracle.PricePoint memory p = _pricePoint(5_000e6, 800); // same timestamp as setUp
        bytes memory sig = _signPrice(signerPk, CARD, p);
        vm.expectRevert();
        oracle.submitPrice(CARD, p, sig);
    }

    function test_submitPrice_rejectsLargeJump_adminCanOverride() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        CardPriceOracle.PricePoint memory p = _pricePoint(10_000e6, 800); // +100%
        bytes memory sig = _signPrice(signerPk, CARD, p);
        vm.expectRevert(abi.encodeWithSelector(CardPriceOracle.DeviationTooLarge.selector, 5_000e6, 10_000e6));
        oracle.submitPrice(CARD, p, sig);

        vm.prank(admin);
        oracle.forceSetPrice(CARD, p);
        assertEq(oracle.getPrice(CARD).fairValueUsd, 10_000e6);
    }

    function test_submitPrice_rejectsFutureTimestamp() public {
        CardPriceOracle.PricePoint memory p = _pricePoint(5_000e6, 800);
        p.updatedAt = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory sig = _signPrice(signerPk, CARD, p);
        vm.expectRevert(abi.encodeWithSelector(CardPriceOracle.FutureTimestamp.selector, p.updatedAt));
        oracle.submitPrice(CARD, p, sig);
    }

    function test_getFreshPrice_staleness() public {
        oracle.getFreshPrice(CARD, 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.expectRevert();
        oracle.getFreshPrice(CARD, 1 days);
        (bool ok,) = oracle.tryGetFreshPrice(CARD, 1 days);
        assertFalse(ok);
        vm.expectRevert(abi.encodeWithSelector(CardPriceOracle.PriceUnavailable.selector, bytes32("x")));
        oracle.getFreshPrice(bytes32("x"), 1 days);
    }
}

contract NftTest is Base {
    uint256 tokenId = uint256(SLAB);

    function setUp() public override {
        super.setUp();
        vm.prank(vault);
        nft.mint(buyer, SLAB, CARD, META);
    }

    function test_mint_uniquePerSlab() public {
        assertEq(nft.ownerOf(tokenId), buyer);
        assertEq(nft.slabOf(tokenId).cardKey, CARD);
        vm.prank(vault);
        vm.expectRevert();
        nft.mint(seller, SLAB, CARD, META);
    }

    function test_onlyMinter() public {
        vm.prank(buyer);
        vm.expectRevert();
        nft.mint(buyer, keccak256("other"), CARD, META);
    }

    function test_redeem_locksThenBurns() public {
        vm.prank(buyer);
        nft.requestRedeem(tokenId);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(VaultCardNFT.TokenLocked.selector, tokenId, VaultCardNFT.Custody.RedeemLocked)
        );
        nft.transferFrom(buyer, seller, tokenId);

        vm.prank(vault);
        nft.completeRedeem(tokenId);
        vm.expectRevert();
        nft.ownerOf(tokenId);

        // The slab can be vaulted again later.
        vm.prank(vault);
        nft.mint(seller, SLAB, CARD, META);
        assertEq(nft.ownerOf(tokenId), seller);
    }

    function test_cancelRedeem_unlocks() public {
        vm.prank(buyer);
        nft.requestRedeem(tokenId);
        vm.prank(buyer);
        nft.cancelRedeem(tokenId);
        vm.prank(buyer);
        nft.transferFrom(buyer, seller, tokenId);
        assertEq(nft.ownerOf(tokenId), seller);
    }

    function test_externalSale_locksThenBurns() public {
        vm.prank(seller);
        vm.expectRevert(VaultCardNFT.NotTokenOwner.selector);
        nft.lockForExternalSale(tokenId);
        vm.prank(buyer);
        nft.lockForExternalSale(tokenId);
        assertEq(uint8(nft.custodyOf(tokenId)), uint8(VaultCardNFT.Custody.ExternalSaleLocked));
        vm.prank(vault);
        nft.completeExternalSale(tokenId);
        assertEq(nft.balanceOf(buyer), 0);
    }

    function test_tokenURI() public view {
        assertEq(
            nft.tokenURI(tokenId), string.concat("https://api.vaultchain.xyz/nft/", vm.toString(SLAB))
        );
    }
}

contract MarketTest is Base {
    uint256 tokenId = uint256(SLAB);

    function setUp() public override {
        super.setUp();
        vm.prank(vault);
        nft.mint(seller, SLAB, CARD, META);
        vm.startPrank(seller);
        nft.setApprovalForAll(address(market), true);
        market.list(tokenId, PRICE);
        vm.stopPrank();
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function test_buy_swapsAtomically() public {
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        market.buy(tokenId, PRICE);
        assertEq(nft.ownerOf(tokenId), buyer);
        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE - PRICE / 100);
        assertEq(usdc.balanceOf(treasury), 100_000e6 + PRICE / 100);
        (address s,) = market.listings(tokenId);
        assertEq(s, address(0));
    }

    function test_buy_priceProtection() public {
        vm.prank(seller);
        market.list(tokenId, PRICE + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(VaultMarket.PriceMismatch.selector, PRICE + 1, PRICE));
        market.buy(tokenId, PRICE);
    }

    function test_buy_staleAfterRedeemRequest() public {
        vm.prank(seller);
        nft.requestRedeem(tokenId);
        vm.prank(buyer);
        vm.expectRevert(VaultMarket.StaleListing.selector);
        market.buy(tokenId, PRICE);
    }

    function test_buy_staleAfterOwnerChanged() public {
        vm.prank(seller);
        nft.transferFrom(seller, admin, tokenId);
        vm.prank(buyer);
        vm.expectRevert(VaultMarket.StaleListing.selector);
        market.buy(tokenId, PRICE);
    }

    function test_onlyOwnerCanList() public {
        vm.prank(buyer);
        vm.expectRevert(VaultMarket.NotOwner.selector);
        market.list(tokenId, 1);
    }
}
