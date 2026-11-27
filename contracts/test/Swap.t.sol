// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SwapEscrow} from "../src/SwapEscrow.sol";
import {VaultSwap} from "../src/VaultSwap.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";

/// Party A = `buyer`  gives CARD  (PSA 10, fair $5,000, vol 8%) + $1,000 top-up
/// Party B = `seller` gives CARD2 (PSA 10, fair $6,000, vol 6%)
/// Deposit per side = $6,000 x (10% + 2 x 8%) = $1,560
contract SwapEscrowTest is Base {
    uint128 constant TOPUP = 1_000e6;
    uint128 constant DEP = 1_560e6;

    uint8 constant PHYS = 0;
    uint8 constant VAULTED = 1;
    uint8 constant SHIP = 0;
    uint8 constant KEEP = 1;

    // ------------------------------------------------------------------ helpers

    function _leg(address owner, bytes32 card, bytes32 slab, bytes32 meta, uint8 kind, uint8 delivery)
        internal
        pure
        returns (SwapEscrow.Leg memory)
    {
        return SwapEscrow.Leg({
            owner: owner, cardKey: card, slabId: slab, metadataHash: meta, kind: kind, delivery: delivery
        });
    }

    function _swapTerms(uint8 kindA, uint8 kindB, uint8 delivery, uint256 nonce)
        internal
        view
        returns (SwapEscrow.SwapTerms memory)
    {
        return SwapEscrow.SwapTerms({
            a: _leg(buyer, CARD, SLAB, META, kindA, delivery),
            b: _leg(seller, CARD2, SLAB2, META2, kindB, delivery),
            topUpUsd: TOPUP,
            topUpFrom: 1,
            depositWindow: 1 days,
            shipWindow: 3 days,
            inspectWindow: 2 days,
            nonce: nonce,
            signDeadline: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _createSwap(SwapEscrow.SwapTerms memory t) internal returns (bytes32 id) {
        bytes32 digest = swapEscrow.hashSwapTerms(t);
        id = swapEscrow.createSwap(t, _sign(buyerPk, digest), _sign(sellerPk, digest));
    }

    function _fundBoth(bytes32 id) internal {
        vm.prank(buyer);
        swapEscrow.fund(id);
        vm.prank(seller);
        swapEscrow.fund(id);
    }

    function _lockedPhysical(uint8 delivery) internal returns (bytes32 id) {
        id = _createSwap(_swapTerms(PHYS, PHYS, delivery, 1));
        _fundBoth(id);
    }

    function _sstatus(bytes32 id) internal view returns (SwapEscrow.Status) {
        return swapEscrow.getSwap(id).status;
    }

    function _assertSwapSolvent() internal view {
        assertGe(usdc.balanceOf(address(swapEscrow)), swapEscrow.totalHeld());
    }

    // ------------------------------------------------------------------ create

    function test_create_sizesDepositFromBothCards() public {
        bytes32 id = _createSwap(_swapTerms(PHYS, PHYS, KEEP, 1));
        SwapEscrow.Swap memory s = swapEscrow.getSwap(id);
        assertEq(s.depositUsd, DEP);
        assertEq(s.refValueUsd[0], 5_000e6);
        assertEq(s.refValueUsd[1], 6_000e6);
        assertEq(uint8(s.status), uint8(SwapEscrow.Status.Signed));
        assertEq(swapEscrow.expectedPayment(id, buyer), DEP + TOPUP); // top-up payer locks both
        assertEq(swapEscrow.expectedPayment(id, seller), DEP);
    }

    function test_create_rejectsValueMismatchWithoutTopUp() public {
        SwapEscrow.SwapTerms memory t = _swapTerms(PHYS, PHYS, KEEP, 1);
        t.topUpUsd = 0;
        t.topUpFrom = 0;
        bytes32 digest = swapEscrow.hashSwapTerms(t);
        bytes memory sa = _sign(buyerPk, digest);
        bytes memory sb = _sign(sellerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(SwapEscrow.ValueMismatch.selector, 5_000e6, 6_000e6));
        swapEscrow.createSwap(t, sa, sb);
    }

    function test_create_rejectsBadSignatureAndReplay() public {
        SwapEscrow.SwapTerms memory t = _swapTerms(PHYS, PHYS, KEEP, 1);
        bytes32 digest = swapEscrow.hashSwapTerms(t);
        bytes memory sa = _sign(buyerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(SwapEscrow.BadSignature.selector, seller));
        swapEscrow.createSwap(t, sa, _sign(0xBAD, digest));

        swapEscrow.createSwap(t, sa, _sign(sellerPk, digest));
        vm.expectRevert(SwapEscrow.SwapExists.selector);
        swapEscrow.createSwap(t, sa, _sign(sellerPk, digest));
    }

    function test_create_vaultedLegMustMatchNft() public {
        vm.prank(vault);
        nft.mint(seller, SLAB, CARD, META); // token exists but belongs to B, not A
        SwapEscrow.SwapTerms memory t = _swapTerms(VAULTED, PHYS, KEEP, 1);
        bytes32 digest = swapEscrow.hashSwapTerms(t);
        bytes memory sa = _sign(buyerPk, digest);
        bytes memory sb = _sign(sellerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(SwapEscrow.NftMismatch.selector, 0));
        swapEscrow.createSwap(t, sa, sb);
    }

    // ------------------------------------------------------------------ happy paths

    function test_physicalSwap_keepInVault_mintsCrossNfts() public {
        bytes32 id = _lockedPhysical(KEEP);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Locked));

        vm.prank(buyer);
        swapEscrow.markShipped(id, keccak256("A-SF1"));
        vm.prank(seller);
        swapEscrow.markShipped(id, keccak256("B-SF2"));
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Inspecting));

        vm.startPrank(vault);
        swapEscrow.submitInspection(id, 0, true, keccak256("rA"));
        swapEscrow.submitInspection(id, 1, true, keccak256("rB"));
        vm.stopPrank();

        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Completed));
        assertEq(nft.ownerOf(uint256(SLAB2)), buyer); // A received B's card
        assertEq(nft.ownerOf(uint256(SLAB)), seller); // B received A's card
        // A: deposit - 1% of $6,000; B: deposit - 1% of $5,000 + top-up; treasury: both fees
        assertEq(swapEscrow.credits(buyer), DEP - 60e6);
        assertEq(swapEscrow.credits(seller), DEP - 50e6 + TOPUP);
        assertEq(swapEscrow.credits(treasury), 110e6);

        uint256 before = usdc.balanceOf(seller);
        vm.prank(seller);
        swapEscrow.withdraw();
        assertEq(usdc.balanceOf(seller), before + DEP - 50e6 + TOPUP);
        _assertSwapSolvent();
    }

    function test_physicalSwap_shipOut_awaitsDelivery() public {
        bytes32 id = _lockedPhysical(SHIP);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.prank(seller);
        swapEscrow.markShipped(id, 0);
        vm.startPrank(vault);
        swapEscrow.submitInspection(id, 1, true, 0);
        swapEscrow.submitInspection(id, 0, true, 0);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.AwaitingDelivery));
        swapEscrow.confirmDelivered(id);
        vm.stopPrank();
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Completed));
        assertEq(nft.balanceOf(buyer) + nft.balanceOf(seller), 0); // nothing minted
    }

    function test_mixedSwap_vaultedNftForPhysical() public {
        vm.prank(vault);
        nft.mint(buyer, SLAB, CARD, META); // A's card is already a vault NFT
        bytes32 id = _createSwap(_swapTerms(VAULTED, PHYS, KEEP, 1));

        vm.prank(buyer);
        swapEscrow.fund(id);
        assertEq(nft.ownerOf(uint256(SLAB)), address(swapEscrow)); // pulled into escrow
        vm.prank(seller);
        swapEscrow.fund(id);

        vm.prank(seller);
        swapEscrow.markShipped(id, 0); // only B has something to ship
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Inspecting));
        vm.prank(vault);
        swapEscrow.submitInspection(id, 1, true, 0);

        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Completed));
        assertEq(nft.ownerOf(uint256(SLAB)), seller);
        assertEq(nft.ownerOf(uint256(SLAB2)), buyer);
    }

    function test_bothVaulted_settlesOnSecondDeposit() public {
        vm.startPrank(vault);
        nft.mint(buyer, SLAB, CARD, META);
        nft.mint(seller, SLAB2, CARD2, META2);
        vm.stopPrank();
        bytes32 id = _createSwap(_swapTerms(VAULTED, VAULTED, KEEP, 1));
        _fundBoth(id);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Completed));
        assertEq(nft.ownerOf(uint256(SLAB)), seller);
        assertEq(nft.ownerOf(uint256(SLAB2)), buyer);
    }

    function test_hspDeposit_attributedByRelayer() public {
        bytes32 id = _createSwap(_swapTerms(PHYS, PHYS, KEEP, 1));
        usdc.mint(address(swapEscrow), DEP); // HSP Gateway paid B's deposit to pay_to = SwapEscrow
        vm.prank(relayer);
        swapEscrow.recordHspPayment(id, seller, DEP, keccak256("hsp-req-1"));
        assertTrue(swapEscrow.getSwap(id).funded[1]);

        vm.prank(relayer);
        vm.expectRevert(SwapEscrow.PaymentRefUsed.selector);
        swapEscrow.recordHspPayment(id, buyer, DEP + TOPUP, keccak256("hsp-req-1"));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SwapEscrow.InsufficientUnallocated.selector, 0, DEP + TOPUP));
        swapEscrow.recordHspPayment(id, buyer, DEP + TOPUP, keccak256("hsp-req-2"));
        _assertSwapSolvent();
    }

    // ------------------------------------------------------------------ defaults

    function test_shipDefault_floorPenalty_returnsTopUp() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        swapEscrow.claimShipDefault(id); // B never shipped; oracle stale => floor 5% of $6,000

        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Defaulted));
        assertEq(swapEscrow.credits(buyer), DEP + 300e6 + TOPUP);
        assertEq(swapEscrow.credits(seller), DEP - 300e6);
        _assertSwapSolvent();
    }

    function test_shipDefault_spreadMoveCompensated() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        _setPrice(CARD, 5_000e6, 800); // A's card flat
        _setPrice(CARD2, 7_000e6, 600); // B's card +$1,000: B walks away to sell elsewhere
        swapEscrow.claimShipDefault(id);
        assertEq(swapEscrow.credits(buyer), DEP + 1_000e6 + TOPUP);
        assertEq(swapEscrow.credits(seller), DEP - 1_000e6);
    }

    function test_shipDefault_neitherShipped_cancelsAndRefundsAll() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        swapEscrow.claimShipDefault(id);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Cancelled));
        assertEq(swapEscrow.credits(buyer), DEP + TOPUP);
        assertEq(swapEscrow.credits(seller), DEP);
    }

    function test_shipDefault_returnsEscrowedNft() public {
        vm.prank(vault);
        nft.mint(buyer, SLAB, CARD, META);
        bytes32 id = _createSwap(_swapTerms(VAULTED, PHYS, KEEP, 1));
        _fundBoth(id);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        swapEscrow.claimShipDefault(id); // B never shipped
        assertEq(nft.ownerOf(uint256(SLAB)), buyer);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Defaulted));
    }

    function test_cancelUnfunded_returnsNftAndDeposit() public {
        vm.prank(vault);
        nft.mint(buyer, SLAB, CARD, META);
        bytes32 id = _createSwap(_swapTerms(VAULTED, PHYS, KEEP, 1));
        vm.prank(buyer);
        swapEscrow.fund(id);
        vm.expectRevert(SwapEscrow.DeadlineNotReached.selector);
        swapEscrow.cancelUnfunded(id);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        swapEscrow.cancelUnfunded(id);
        assertEq(nft.ownerOf(uint256(SLAB)), buyer);
        assertEq(swapEscrow.credits(buyer), DEP + TOPUP);
    }

    function test_lateShipRejected() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        vm.prank(buyer);
        vm.expectRevert(SwapEscrow.DeadlinePassed.selector);
        swapEscrow.markShipped(id, 0);
    }

    // ------------------------------------------------------------------ disputes

    function test_inspectionFail_disputeAwardsFromFaultyParty() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.prank(seller);
        swapEscrow.markShipped(id, 0);
        vm.prank(vault);
        swapEscrow.submitInspection(id, 1, false, keccak256("cert mismatch"));
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Disputed));

        vm.prank(arbiter);
        swapEscrow.resolveDispute(id, 2, 500e6);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Refunded));
        assertEq(swapEscrow.credits(buyer), DEP + 500e6 + TOPUP);
        assertEq(swapEscrow.credits(seller), DEP - 500e6);

        vm.prank(vault);
        swapEscrow.recordReturn(id, 0, keccak256("return A"));
    }

    function test_inspectionTimeout_escalates() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.prank(seller);
        swapEscrow.markShipped(id, 0);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        swapEscrow.escalateInspectionTimeout(id);
        assertEq(uint8(_sstatus(id)), uint8(SwapEscrow.Status.Disputed));
    }

    function test_onlyVaultInspects_onlyPartiesShip() public {
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SwapEscrow.NotParty.selector);
        swapEscrow.markShipped(id, 0);
        vm.prank(buyer);
        swapEscrow.markShipped(id, 0);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(SwapEscrow.WrongLegState.selector, SwapEscrow.LegState.Shipped)
        );
        swapEscrow.markShipped(id, 0);
        vm.prank(seller);
        swapEscrow.markShipped(id, 0);
        vm.prank(buyer);
        vm.expectRevert();
        swapEscrow.submitInspection(id, 0, true, 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Any price move: a ship default never pays out more than was locked.
    function testFuzz_shipDefault_conserves(uint128 fairA, uint128 fairB, bool aDefaults) public {
        fairA = uint128(bound(fairA, 3_600e6, 6_400e6)); // within the oracle's 30% jump limit
        fairB = uint128(bound(fairB, 4_300e6, 7_700e6));
        bytes32 id = _lockedPhysical(KEEP);
        vm.prank(aDefaults ? seller : buyer);
        swapEscrow.markShipped(id, 0);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        _setPrice(CARD, fairA, 800);
        _setPrice(CARD2, fairB, 600);
        swapEscrow.claimShipDefault(id);

        uint256 total = swapEscrow.credits(buyer) + swapEscrow.credits(seller);
        assertEq(total, 2 * uint256(DEP) + TOPUP);
        // the innocent side always gets at least its deposit + the 5% floor (+ its own top-up back)
        if (aDefaults) assertGe(swapEscrow.credits(seller), DEP + 300e6);
        else assertGe(swapEscrow.credits(buyer), DEP + 300e6 + TOPUP);
        _assertSwapSolvent();
    }
}

contract VaultSwapTest is Base {
    uint256 a = uint256(SLAB);
    uint256 b = uint256(SLAB2);

    function setUp() public override {
        super.setUp();
        vm.startPrank(vault);
        nft.mint(buyer, SLAB, CARD, META);
        nft.mint(seller, SLAB2, CARD2, META2);
        vm.stopPrank();
    }

    function _offer(uint256 want, bytes32 wantKey, uint128 topUp, bool makerPays) internal returns (uint256) {
        vm.prank(buyer);
        return vswap.createOffer(a, want, wantKey, topUp, makerPays, uint64(vm.getBlockTimestamp() + 1 days));
    }

    function test_swapSpecificToken_withTopUpAndFees() public {
        uint256 id = _offer(b, bytes32(0), 1_000e6, true);
        uint256 makerBal = usdc.balanceOf(buyer);
        uint256 takerBal = usdc.balanceOf(seller);
        vm.prank(seller);
        vswap.acceptOffer(id, b);
        assertEq(nft.ownerOf(a), seller);
        assertEq(nft.ownerOf(b), buyer);
        assertEq(usdc.balanceOf(buyer), makerBal - 1_000e6 - 5e6);
        assertEq(usdc.balanceOf(seller), takerBal + 1_000e6 - 5e6);
        assertEq(usdc.balanceOf(treasury), 100_000e6 + 10e6);
        (address maker,,,,,,) = vswap.offers(id);
        assertEq(maker, address(0));
    }

    function test_swapAnyOfCardType() public {
        uint256 id = _offer(0, CARD2, 0, false);
        vm.prank(seller);
        vswap.acceptOffer(id, b);
        assertEq(nft.ownerOf(b), buyer);
    }

    function test_rejectsWrongCardType() public {
        vm.prank(vault);
        nft.mint(seller, keccak256("PSA|999"), keccak256("other card"), META);
        uint256 id = _offer(0, CARD2, 0, false);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.NotWanted.selector);
        vswap.acceptOffer(id, uint256(keccak256("PSA|999")));
    }

    function test_staleWhenMakerNoLongerHoldsCard() public {
        uint256 id = _offer(b, bytes32(0), 0, false);
        vm.prank(buyer);
        nft.requestRedeem(a);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.StaleOffer.selector);
        vswap.acceptOffer(id, b);
    }

    function test_takerTokenMustBeInVault() public {
        uint256 id = _offer(b, bytes32(0), 0, false);
        vm.prank(seller);
        nft.lockForExternalSale(b);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.NotInVault.selector);
        vswap.acceptOffer(id, b);
    }

    function test_expiryAndCancel() public {
        uint256 id = _offer(b, bytes32(0), 0, false);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.OfferExpired.selector);
        vswap.acceptOffer(id, b);

        uint256 id2 = _offer(b, bytes32(0), 0, false);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.NotOwner.selector);
        vswap.cancelOffer(id2);
        vm.prank(buyer);
        vswap.cancelOffer(id2);
        vm.prank(seller);
        vm.expectRevert(VaultSwap.OfferNotFound.selector);
        vswap.acceptOffer(id2, b);
    }

    function test_offerNeedsExactlyOneTarget() public {
        vm.startPrank(buyer);
        vm.expectRevert(VaultSwap.BadOffer.selector);
        vswap.createOffer(a, b, CARD2, 0, false, uint64(vm.getBlockTimestamp() + 1 days));
        vm.expectRevert(VaultSwap.BadOffer.selector);
        vswap.createOffer(a, 0, bytes32(0), 0, false, uint64(vm.getBlockTimestamp() + 1 days));
        vm.stopPrank();
    }
}
