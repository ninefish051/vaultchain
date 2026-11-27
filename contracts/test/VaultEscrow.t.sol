// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";

contract VaultEscrowTest is Base {
    uint8 constant SHIP = 0;
    uint8 constant VAULT = 1;
    uint128 constant DEPOSIT = 1_300e6; // 10% + 2 x 8% volatility = 26% of $5,000

    // ------------------------------------------------------------------ creation

    function test_createOrder_sizesDepositFromVolatility() public {
        bytes32 id = _create(_terms(VAULT, 1));
        VaultEscrow.Order memory o = escrow.getOrder(id);
        assertEq(uint8(o.status), uint8(VaultEscrow.Status.Signed));
        assertEq(o.depositUsd, DEPOSIT);
        assertEq(o.refFairValueUsd, 5_000e6);
        assertEq(o.deadline, vm.getBlockTimestamp() + 1 days);
    }

    function test_depositBps_isClamped() public view {
        assertEq(escrow.depositBpsFor(0), 1000);
        assertEq(escrow.depositBpsFor(500), 2000);
        assertEq(escrow.depositBpsFor(5000), 3000);
    }

    function test_createOrder_rejectsWrongSigner() public {
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 1);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory bad = _sign(0xBAD, digest);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.BadSignature.selector, seller));
        escrow.createOrder(t, _sign(buyerPk, digest), bad);
    }

    function test_createOrder_cannotReplay() public {
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 1);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory b = _sign(buyerPk, digest);
        bytes memory s = _sign(sellerPk, digest);
        escrow.createOrder(t, b, s);
        vm.expectRevert(VaultEscrow.OrderExists.selector);
        escrow.createOrder(t, b, s);
    }

    function test_cancelNonce_blocksSignedOrder() public {
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 7);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory b = _sign(buyerPk, digest);
        bytes memory s = _sign(sellerPk, digest);
        vm.prank(seller);
        escrow.cancelNonce(7);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.NonceAlreadyUsed.selector, seller, 7));
        escrow.createOrder(t, b, s);
    }

    function test_createOrder_rejectsExpiredSignature() public {
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 1);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory b = _sign(buyerPk, digest);
        bytes memory s = _sign(sellerPk, digest);
        vm.expectRevert(VaultEscrow.SignatureExpired.selector);
        escrow.createOrder(t, b, s);
    }

    function test_createOrder_rejectsStalePrice() public {
        vm.warp(vm.getBlockTimestamp() + 3 days);
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 1);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory b = _sign(buyerPk, digest);
        bytes memory s = _sign(sellerPk, digest);
        vm.expectRevert();
        escrow.createOrder(t, b, s);
    }

    function test_createOrder_rejectsPriceFarFromFairValue() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _forcePrice(CARD, 2_000e6, 800); // order price $5,000 is +150% vs fair value
        VaultEscrow.OrderTerms memory t = _terms(VAULT, 1);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory b = _sign(buyerPk, digest);
        bytes memory s = _sign(sellerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.PriceOutOfBounds.selector, PRICE, 2_000e6));
        escrow.createOrder(t, b, s);
    }

    // ------------------------------------------------------------------ happy paths

    function test_happyPath_keepInVault_mintsNftToBuyer() public {
        bytes32 id = _createAndLock(VAULT);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Locked));
        assertEq(escrow.totalHeld(), 2 * DEPOSIT);

        vm.prank(seller);
        escrow.markShipped(id, keccak256("SF123"));
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Inspecting));

        vm.prank(vault);
        escrow.submitInspection(id, true, keccak256("report"));
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.PaymentWindow));
        assertEq(escrow.credits(seller), DEPOSIT, "seller bond released");
        assertEq(escrow.expectedPayment(id, buyer), PRICE);

        vm.prank(buyer);
        escrow.fund(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Completed));
        assertEq(nft.ownerOf(uint256(SLAB)), buyer);
        assertEq(uint8(nft.custodyOf(uint256(SLAB))), uint8(VaultCardNFT.Custody.InVault));

        uint256 fee = PRICE / 100;
        assertEq(escrow.credits(seller), DEPOSIT + PRICE - fee);
        assertEq(escrow.credits(buyer), DEPOSIT, "buyer collateral returned");
        assertEq(escrow.credits(treasury), fee);
        _assertSolvent();

        uint256 before = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.withdraw();
        assertEq(usdc.balanceOf(seller), before + DEPOSIT + PRICE - fee);
        vm.prank(buyer);
        escrow.withdraw();
        vm.prank(treasury);
        escrow.withdraw();
        assertEq(escrow.totalHeld(), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_happyPath_shipToBuyer() public {
        bytes32 id = _toPaymentWindow(SHIP);
        vm.prank(buyer);
        escrow.fund(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.AwaitingDelivery));
        vm.prank(vault);
        escrow.confirmDelivered(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Completed));
        assertEq(nft.balanceOf(buyer), 0, "no NFT when shipped");
    }

    function test_fund_rejectsOverpayAndStrangers() public {
        bytes32 id = _create(_terms(VAULT, 1));
        vm.prank(buyer);
        escrow.fund(id);
        vm.prank(buyer);
        vm.expectRevert(VaultEscrow.NothingExpected.selector);
        escrow.fund(id);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(VaultEscrow.NothingExpected.selector);
        escrow.fund(id);
    }

    // ------------------------------------------------------------------ EIP-3009 + HSP

    function test_fundWithAuthorization() public {
        bytes32 id = _create(_terms(VAULT, 1));
        bytes32 nonce = keccak256("auth-1");
        uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        buyer,
                        address(escrow),
                        uint256(DEPOSIT),
                        uint256(0),
                        validBefore,
                        nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        vm.prank(relayer); // anyone can submit the signed authorization
        escrow.fundWithAuthorization(id, buyer, 0, validBefore, nonce, v, r, s);
        assertTrue(escrow.getOrder(id).buyerDeposited);
        _assertSolvent();
    }

    function test_hspPayment_isAttributedByRelayer() public {
        bytes32 id = _create(_terms(VAULT, 1));
        // HSP Gateway transfers USDC straight to the escrow (pay_to = escrow).
        vm.prank(buyer);
        usdc.transfer(address(escrow), DEPOSIT);
        assertEq(escrow.unallocatedBalance(), DEPOSIT);

        bytes32 ref = keccak256("hsp:payment_request_id:abc");
        vm.prank(relayer);
        escrow.recordHspPayment(id, buyer, DEPOSIT, ref);
        assertTrue(escrow.getOrder(id).buyerDeposited);
        assertEq(escrow.unallocatedBalance(), 0);

        vm.prank(relayer);
        vm.expectRevert(VaultEscrow.PaymentRefUsed.selector);
        escrow.recordHspPayment(id, seller, DEPOSIT, ref);
    }

    function test_hspPayment_cannotClaimMoneyThatDidNotArrive() public {
        bytes32 id = _create(_terms(VAULT, 1));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.InsufficientUnallocated.selector, 0, DEPOSIT));
        escrow.recordHspPayment(id, buyer, DEPOSIT, keccak256("ref"));
    }

    function test_hspPayment_onlyRelayer() public {
        bytes32 id = _create(_terms(VAULT, 1));
        vm.prank(buyer);
        usdc.transfer(address(escrow), DEPOSIT);
        vm.prank(buyer);
        vm.expectRevert();
        escrow.recordHspPayment(id, buyer, DEPOSIT, keccak256("ref"));
    }

    function test_hspPayment_wrongAmountRejected() public {
        bytes32 id = _create(_terms(VAULT, 1));
        vm.prank(buyer);
        usdc.transfer(address(escrow), DEPOSIT + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.AmountMismatch.selector, DEPOSIT, DEPOSIT + 1));
        escrow.recordHspPayment(id, buyer, DEPOSIT + 1, keccak256("ref"));
    }

    function test_rescueUnallocated_cannotTouchOrderFunds() public {
        bytes32 id = _createAndLock(VAULT);
        id;
        vm.prank(buyer);
        usdc.transfer(address(escrow), 10e6); // stray payment
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(VaultEscrow.InsufficientUnallocated.selector, 10e6, 11e6));
        escrow.rescueUnallocated(admin, 11e6);
        escrow.rescueUnallocated(buyer, 10e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), 2 * DEPOSIT);
    }

    // ------------------------------------------------------------------ cancellation

    function test_cancelUnfunded_refundsPartialDeposit() public {
        bytes32 id = _create(_terms(VAULT, 1));
        vm.prank(buyer);
        escrow.fund(id);
        vm.expectRevert(VaultEscrow.DeadlineNotReached.selector);
        escrow.cancelUnfunded(id);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        escrow.cancelUnfunded(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Cancelled));
        assertEq(escrow.credits(buyer), DEPOSIT);
        vm.prank(seller);
        vm.expectRevert(VaultEscrow.NothingExpected.selector);
        escrow.fund(id);
    }

    // ------------------------------------------------------------------ defaults

    function test_buyerDefault_floorPenaltyWhenPriceFlat() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        _setPrice(CARD, 5_000e6, 800); // refresh so it is not stale
        escrow.claimBuyerDefault(id);
        uint256 penalty = PRICE * 5 / 100; // 5% floor = $250
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.BuyerDefault));
        assertEq(escrow.credits(seller), DEPOSIT + penalty);
        assertEq(escrow.credits(buyer), DEPOSIT - penalty);
        _assertSolvent();
    }

    function test_buyerDefault_compensatesPriceDrop() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _setPrice(CARD, 4_000e6, 800); // market fell 20%: buyer would rather walk away
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        escrow.claimBuyerDefault(id);
        uint256 penalty = 1_000e6; // 20% of $5,000
        assertEq(escrow.credits(seller), DEPOSIT + penalty);
        assertEq(escrow.credits(buyer), DEPOSIT - penalty);
    }

    function test_buyerDefault_penaltyCappedAtDeposit() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        _forcePrice(CARD, 1_000e6, 800); // -80%, beyond the deposit
        escrow.claimBuyerDefault(id);
        assertEq(escrow.credits(seller), 2 * DEPOSIT);
        assertEq(escrow.credits(buyer), 0);
    }

    function test_buyerDefault_staleOracleFallsBackToFloor() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 5 days); // oracle now stale
        escrow.claimBuyerDefault(id);
        assertEq(escrow.credits(seller), DEPOSIT + PRICE * 5 / 100);
    }

    function test_buyerCannotPayAfterDeadline() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        vm.prank(buyer);
        vm.expectRevert(VaultEscrow.NothingExpected.selector);
        escrow.fund(id);
    }

    function test_sellerNoShow_compensatesPriceRise() public {
        bytes32 id = _createAndLock(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        _setPrice(CARD, 6_000e6, 800); // market rose 20%: seller would rather keep the card
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        escrow.claimSellerNoShow(id);
        uint256 penalty = 1_000e6;
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.SellerDefault));
        assertEq(escrow.credits(buyer), DEPOSIT + penalty);
        assertEq(escrow.credits(seller), DEPOSIT - penalty);
        _assertSolvent();
    }

    function test_sellerCannotShipAfterDeadline() public {
        bytes32 id = _createAndLock(VAULT);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        vm.prank(seller);
        vm.expectRevert(VaultEscrow.DeadlinePassed.selector);
        escrow.markShipped(id, bytes32(0));
    }

    // ------------------------------------------------------------------ disputes

    function test_failedInspection_disputeResolvedAgainstSeller() public {
        bytes32 id = _createAndLock(VAULT);
        vm.prank(seller);
        escrow.markShipped(id, keccak256("SF123"));
        vm.prank(vault);
        escrow.submitInspection(id, false, keccak256("fake slab"));
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Disputed));

        vm.prank(arbiter);
        vm.expectRevert(VaultEscrow.AwardTooLarge.selector);
        escrow.resolveDispute(id, DEPOSIT + 1);

        vm.prank(arbiter);
        escrow.resolveDispute(id, DEPOSIT);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Refunded));
        assertEq(escrow.credits(buyer), 2 * DEPOSIT);
        assertEq(escrow.credits(seller), 0);
        _assertSolvent();
    }

    function test_inspectionTimeout_escalates() public {
        bytes32 id = _createAndLock(VAULT);
        vm.prank(seller);
        escrow.markShipped(id, keccak256("SF123"));
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        escrow.escalateInspectionTimeout(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Disputed));
    }

    function test_onlyVaultCanInspect() public {
        bytes32 id = _createAndLock(VAULT);
        vm.prank(seller);
        escrow.markShipped(id, keccak256("SF123"));
        vm.prank(seller);
        vm.expectRevert();
        escrow.submitInspection(id, true, bytes32(0));
    }

    // ------------------------------------------------------------------ buyout / return

    function test_buyout_afterBuyerDefault() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        escrow.claimBuyerDefault(id);

        vm.prank(treasury);
        vm.expectRevert(VaultEscrow.NoConsent.selector);
        escrow.executeBuyout(id);

        vm.prank(seller);
        escrow.consentToBuyout(id);
        vm.prank(treasury);
        escrow.executeBuyout(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.BoughtOut));
        assertEq(nft.ownerOf(uint256(SLAB)), treasury);
        assertEq(escrow.credits(seller), DEPOSIT + PRICE * 5 / 100 + PRICE);
        _assertSolvent();
    }

    function test_returnAfterBuyerDefault() public {
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        escrow.claimBuyerDefault(id);
        vm.prank(vault);
        escrow.markReturned(id);
        assertEq(uint8(_status(id)), uint8(VaultEscrow.Status.Returned));
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Whatever the market does, payouts of a default never exceed what was deposited.
    function testFuzz_buyerDefault_conservesFunds(uint128 newFair) public {
        newFair = uint128(bound(newFair, 1e6, 50_000e6));
        bytes32 id = _toPaymentWindow(VAULT);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1);
        _forcePrice(CARD, newFair, 800);
        escrow.claimBuyerDefault(id);
        assertEq(escrow.credits(buyer) + escrow.credits(seller), 2 * DEPOSIT);
        assertGe(escrow.credits(seller), DEPOSIT + PRICE * 5 / 100);
        _assertSolvent();
    }

    function testFuzz_sellerNoShow_conservesFunds(uint128 newFair) public {
        newFair = uint128(bound(newFair, 1e6, 50_000e6));
        bytes32 id = _createAndLock(VAULT);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        _forcePrice(CARD, newFair, 800);
        escrow.claimSellerNoShow(id);
        assertEq(escrow.credits(buyer) + escrow.credits(seller), 2 * DEPOSIT);
        _assertSolvent();
    }
}
