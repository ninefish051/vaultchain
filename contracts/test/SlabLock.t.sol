// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";
import {SwapEscrow} from "../src/SwapEscrow.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";

/// A physical slab can be in at most one active order or swap, across both escrows.
contract SlabLockTest is Base {
    function _swapTerms(uint256 nonce) internal view returns (SwapEscrow.SwapTerms memory) {
        return SwapEscrow.SwapTerms({
            a: SwapEscrow.Leg({owner: seller, cardKey: CARD, slabId: SLAB, metadataHash: META, kind: 0, delivery: 1}),
            b: SwapEscrow.Leg({owner: buyer, cardKey: CARD2, slabId: SLAB2, metadataHash: META2, kind: 0, delivery: 1}),
            topUpUsd: 1_000e6,
            topUpFrom: 1,
            depositWindow: 1 days,
            shipWindow: 3 days,
            inspectWindow: 2 days,
            nonce: nonce,
            signDeadline: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function test_secondOrderForSameSlabReverts() public {
        bytes32 first = _create(_terms(1, 1));
        VaultEscrow.OrderTerms memory t = _terms(1, 2);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory bs = _sign(buyerPk, digest);
        bytes memory ss = _sign(sellerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(VaultCardNFT.SlabBusy.selector, uint256(SLAB), address(escrow)));
        escrow.createOrder(t, bs, ss);
        assertEq(nft.slabLockedBy(uint256(SLAB)), address(escrow));
        assertTrue(first != bytes32(0));
    }

    function test_slabInOrderCannotBeSwapped() public {
        _create(_terms(1, 1));
        SwapEscrow.SwapTerms memory t = _swapTerms(9);
        bytes32 digest = swapEscrow.hashSwapTerms(t);
        bytes memory sa = _sign(sellerPk, digest);
        bytes memory sb = _sign(buyerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(VaultCardNFT.SlabBusy.selector, uint256(SLAB), address(escrow)));
        swapEscrow.createSwap(t, sa, sb);
    }

    function test_vaultedSlabCannotGoThroughEscrow() public {
        vm.prank(vault);
        nft.mint(seller, SLAB, CARD, META);
        VaultEscrow.OrderTerms memory t = _terms(1, 1);
        bytes32 digest = escrow.hashOrderTerms(t);
        bytes memory bs = _sign(buyerPk, digest);
        bytes memory ss = _sign(sellerPk, digest);
        vm.expectRevert(abi.encodeWithSelector(VaultCardNFT.SlabAlreadyMinted.selector, uint256(SLAB)));
        escrow.createOrder(t, bs, ss);
    }

    function test_vaultCannotMintSlabInTrade() public {
        _create(_terms(1, 1));
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(VaultCardNFT.SlabBusy.selector, uint256(SLAB), address(escrow)));
        nft.mint(seller, SLAB, CARD, META);
    }

    function test_slabFreedAfterCancellation() public {
        bytes32 id = _create(_terms(1, 1));
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        escrow.cancelUnfunded(id);
        assertEq(nft.slabLockedBy(uint256(SLAB)), address(0));
        _setPrice(CARD, 5_000e6, 800); // refresh oracle after the warp
        _create(_terms(1, 2)); // can trade again
    }

    function test_completedOrderReleasesLockAndLeavesNft() public {
        bytes32 id = _toPaymentWindow(1);
        vm.prank(buyer);
        escrow.fund(id); // KeepInVault: NFT minted to buyer, order completed, lock released
        assertEq(nft.slabLockedBy(uint256(SLAB)), address(0));
        assertEq(nft.ownerOf(uint256(SLAB)), buyer);
    }

    function test_onlyLockerUnlocks() public {
        _create(_terms(1, 1));
        vm.expectRevert(VaultCardNFT.NotLocker.selector);
        nft.unlockSlab(SLAB);
        vm.prank(admin);
        vm.expectRevert();
        nft.lockSlab(keccak256("x")); // admin lacks ESCROW_ROLE
    }
}
