// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";

/// Deposits are rounded up to a whole cent so USD-denominated rails (HSP carts) can pay them exactly.
contract RoundingTest is Base {
    function test_depositRoundedUpToCent() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _forcePrice(CARD, 4_999_990_000, 813); // $4,999.99, 8.13% vol -> 26.26%
        VaultEscrow.OrderTerms memory t = _terms(1, 1);
        t.priceUsd = 4_999_990_000;
        bytes32 id = _create(t);
        // raw: 4_999.99 * 26.26% = 1_312.997374 -> 1_313.00
        assertEq(escrow.getOrder(id).depositUsd, 1_313_000_000);
        assertEq(escrow.getOrder(id).depositUsd % 10_000, 0);
    }

    function testFuzz_depositAlwaysWholeCents(uint128 price, uint32 vol) public {
        price = uint128(bound(price, 3_000e6, 7_000e6));
        vol = uint32(bound(vol, 0, 5000));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _forcePrice(CARD, 5_000e6, vol);
        VaultEscrow.OrderTerms memory t = _terms(1, 1);
        t.priceUsd = price;
        bytes32 id = _create(t);
        uint128 dep = escrow.getOrder(id).depositUsd;
        assertEq(dep % 10_000, 0);
        assertGe(dep, (uint256(price) * escrow.depositBpsFor(vol)) / 10_000); // never below the raw deposit
        assertLt(dep - (uint256(price) * escrow.depositBpsFor(vol)) / 10_000, 10_000); // at most one cent above
    }
}
