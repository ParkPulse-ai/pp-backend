import {
  AccountId,
  PrivateKey,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  // Operator/wallet that will vote
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(process.env.OPERATOR_ID),
    PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY)
  );

  const contractId = process.env.CONTRACT_ID;
  const proposalId = 1;
  const support = false; // false = No, true = Yes
  const voterAddress = AccountId.fromString("0.0.5874947").toSolidityAddress(); // convert Hedera ID to solidity address

  try {
    // Call vote() function
    const tx = new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(500_000)
      .setFunction(
        "vote",
        new ContractFunctionParameters()
          .addUint256(proposalId)
          .addBool(support)
          .addAddress(voterAddress) // 👈 new parameter
      );

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);

    console.log(
      "--------------------------------- Vote Transaction ---------------------------------"
    );
    console.log("Proposal ID       :", proposalId);
    console.log("Voter Address     :", voterAddress);
    console.log("Vote Choice       :", support ? "Yes" : "No");
    console.log("Transaction Status:", receipt.status.toString());
    console.log(
      "Hashscan URL      :",
      "https://hashscan.io/testnet/tx/" + response.transactionId.toString()
    );
  } catch (error) {
    console.error("Error voting:", error);
  } finally {
    client.close();
  }
}

main();
