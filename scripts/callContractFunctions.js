// callContractFunctions.js
import {
  AccountId,
  PrivateKey,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  TopicMessageSubmitTransaction,
  ContractCallQuery,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  // const args = process.argv.slice(2);
  // if (args.length < 1) {
  //   console.error("Usage: node callContractFunctions.js <proposalId>");
  //   process.exit(1);
  // }

  // const proposalId = getNextProposalId(); // Proposal ID passed externally
  const parkName = "Aoma Park";
  const message = "Add no trees";
  const parkSize = 120; // in square meters
  const chatTopicHistory = "Initial proposal created";
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  let client;
  try {
    const MY_ACCOUNT_ID = AccountId.fromString(process.env.OPERATOR_ID);
    const MY_PRIVATE_KEY = PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY);

    client = Client.forTestnet();
    client.setOperator(MY_ACCOUNT_ID, MY_PRIVATE_KEY);

    // ---- Create Proposal on Smart Contract ----
    const txContractExecute = new ContractExecuteTransaction()
      .setContractId(process.env.CONTRACT_ID) // replace with your contract ID
      .setGas(500_000)
      .setFunction(
        "createProposal",
        new ContractFunctionParameters()
          // .addUint256(proposalId)
          .addString(parkName)
          .addString(message)
          .addUint256(parkSize)
          .addString(chatTopicHistory)
          .addUint256(deadline)
      );
    const query = new ContractCallQuery()
      .setContractId(process.env.CONTRACT_ID) // your contract ID
      .setGas(100_000)
      .setFunction("proposalCount");

    const queryResult = await query.execute(client);
    const proposalId = queryResult.getUint256(0).toNumber();
    const txResponse = await txContractExecute.execute(client);
    const receipt = await txResponse.getReceipt(client);
    console.log("------------------- Proposal Created -------------------");
    console.log("Transaction ID: ", txResponse.transactionId.toString());
    console.log("Status: ", receipt.status.toString());
    console.log(
      "Hashscan URL: https://hashscan.io/testnet/tx/" +
        txResponse.transactionId.toString()
    );

    // ---- Notify subscribed wallets via Topic ----
    const topicId = "0.0.6590612"; // replace with your topic ID
    const proposalMessage = {
      proposalId,
      parkName,
      message,
      parkSize,
      chatTopicHistory,
      deadline,
      createdAt: Date.now(),
    };

    const txTopicMessageSubmit = new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify(proposalMessage));

    const txTopicResponse = await txTopicMessageSubmit.execute(client);
    const topicReceipt = await txTopicResponse.getReceipt(client);
    console.log("------------------- Topic Notification -------------------");
    console.log("Topic ID: ", topicId);
    console.log("Message status: ", topicReceipt.status.toString());
    console.log(
      "Message Transaction ID: ",
      txTopicResponse.transactionId.toString()
    );
  } catch (error) {
    console.error("Error creating proposal:", error);
  } finally {
    if (client) client.close();
  }
}

main();
