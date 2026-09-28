import type { Page } from "@playwright/test";

const parameters = {
  min_fee_a: 44, min_fee_b: 155381, max_block_size: 90112, max_tx_size: 16384,
  max_block_header_size: 1100, key_deposit: "2000000", pool_deposit: "500000000",
  e_max: 18, n_opt: 500, a0: "0.3", rho: "0.003", tau: "0.2",
  protocol_major_ver: 10, protocol_minor_ver: 0, min_pool_cost: "170000000",
  price_mem: "0.0577", price_step: "0.0000721", max_tx_ex_mem: "14000000",
  max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000",
  max_block_ex_steps: "20000000000", max_val_size: "5000",
  collateral_percent: 150, max_collateral_inputs: 3, coins_per_utxo_word: "4310",
  cost_models_raw: {},
};

const genesis = {
  active_slots_coefficient: 0.05, epoch_length: 432000, max_kes_evolutions: 62,
  max_lovelace_supply: "45000000000000000", network_magic: 1, security_param: 2160,
  slot_length: 1, slots_per_kes_period: 129600, system_start: 1506203091, update_quorum: 5,
};

export async function mockBlockfrost(page: Page) {
  let fundedAddress: string | undefined;
  const requests: string[] = [];
  let submissions = 0;
  await page.route("https://cardano-preprod.blockfrost.io/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v0\//, "");
    requests.push(path);
    if (route.request().method() === "POST") submissions++;
    let body: unknown;
    if (path === "epochs/latest/parameters") body = parameters;
    else if (path === "genesis") body = genesis;
    else if (path === "network/eras") body = [{ start: { time: 0, slot: 0, epoch: 0 }, parameters: { epoch_length: 21600, slot_length: 20, safe_zone: 4320 } }];
    else if (path === "network") body = { stake: { active: "0", live: "0" }, supply: { circulating: "0", total: "45000000000000000" } };
    else if (path === "blocks/latest") body = { height: 100000, hash: "a".repeat(64), slot: 50000000 };
    else if (/^(accounts|addresses)\/.*\/utxos$/.test(path)) {
      body = fundedAddress ? [{ address: fundedAddress, tx_hash: "b".repeat(64), output_index: 0, amount: [{ unit: "lovelace", quantity: "10000000" }] }] : [];
    } else if (/^txs\/.*\/utxos$/.test(path)) body = { inputs: [], outputs: [] };
    else {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { requests, submissions: () => submissions, fund: (address: string) => { fundedAddress = address.replace(/^Address: /, ""); } };
}
