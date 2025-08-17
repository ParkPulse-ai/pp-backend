// deployContract.js
import {
  AccountId,
  PrivateKey,
  Client,
  ContractCreateFlow,
} from "@hashgraph/sdk";

import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  let client;
  try {
    // Operator account
    const MY_ACCOUNT_ID = AccountId.fromString(process.env.OPERATOR_ID);
    const MY_PRIVATE_KEY = PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY);

    // Configure client for testnet
    client = Client.forTestnet();
    client.setOperator(MY_ACCOUNT_ID, MY_PRIVATE_KEY);

    console.log("===> Deploying HederaVotingContract...");

    // Load contract bytecode
    const contractBytecode = fs.readFileSync(
      "HederaVotingBinaries/HederaVoting_sol_HederaVoting.bin",
      "utf8"
    );
    console.log("- Contract bytecode loaded");

    // Create ContractCreateFlow transaction
    const contractCreateFlow = new ContractCreateFlow()
      .setGas(2_000_000) // Increase gas for larger contracts
      .setBytecode(contractBytecode);

    // Submit transaction to Hedera network
    const txResponse = await contractCreateFlow.execute(client);

    // Get receipt
    const receipt = await txResponse.getReceipt(client);

    // Transaction info
    const status = receipt.status;
    const txId = txResponse.transactionId.toString();
    const contractId = receipt.contractId;

    console.log(
      "--------------------------------- Contract Deployment ---------------------------------"
    );
    console.log("Consensus status : ", status.toString());
    console.log("Transaction ID   : ", txId);
    console.log(
      "Hashscan URL     : ",
      `https://hashscan.io/testnet/tx/${txId}`
    );
    console.log("Contract ID      : ", contractId.toString());
  } catch (error) {
    console.error("Deployment failed:", error);
  } finally {
    if (client) client.close();
  }
}

main();
