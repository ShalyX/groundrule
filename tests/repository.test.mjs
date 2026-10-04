import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED = [
  {
    address: "0x4Bdb443424bEe8dd22809dd0B76755109aC89615",
    source: "contracts/drift_permit.py",
    sha256: "796791e83b2b064f726500c505bc44deaca0427b1331cb9e546109958b90cda6",
    methods: [
      "register_dependency",
      "assess_dependency",
      "consume_permit",
      "reconfigure_dependency",
      "is_permit_valid",
      "get_dependency",
      "get_permit",
    ],
    clientMethods: [
      "register_dependency",
      "assess_dependency",
      "is_permit_valid",
      "get_dependency",
      "get_permit",
    ],
  },
  {
    address: "0x4cEdAc7a470d81EFC151564d5887Ba616bF56C31",
    source: "contracts/guarded_consumer.py",
    sha256: "9502ba12229138668a5be72593f63c06822ddf68252580f089b507ab5b2378e3",
    methods: ["start_action", "finalize_action", "get_action"],
    clientMethods: ["start_action", "finalize_action", "get_action"],
  },
];

test("the public repository contains every deployed Groundrule contract source", async () => {
  const manifest = JSON.parse(await readFile("contracts/deployments.studionet.json", "utf8"));
  const client = await readFile("src/lib/driftPermit.ts", "utf8");

  assert.deepEqual(manifest.contracts, EXPECTED);

  for (const contract of EXPECTED) {
    const source = await readFile(contract.source);
    const normalizedSource = source.toString("utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(normalizedSource).digest("hex"), contract.sha256);
    assert.match(client.toLowerCase(), new RegExp(contract.address.toLowerCase()));

    const text = normalizedSource;
    for (const method of contract.methods) {
      assert.match(text, new RegExp(`def ${method}\\(`));
    }
    for (const method of contract.clientMethods) {
      assert.match(client, new RegExp(`\\"${method}\\"`));
    }
  }
});
