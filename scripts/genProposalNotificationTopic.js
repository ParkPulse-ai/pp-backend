import {
  PrivateKey,
  TopicCreateTransaction,
  Client,
  AccountId,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = Client.forTestnet();
  client.setOperator(
    AccountId.fromString(process.env.OPERATOR_ID),
    PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY)
  );

  // Generate a new key for controlling the topic
  const topicPrivateKey = PrivateKey.generateECDSA();
  const topicPublicKey = topicPrivateKey.publicKey;

  // Create the topic and set the submit key
  const txCreateTopic = new TopicCreateTransaction()
    .setTopicMemo("proposalNotification")
    .setSubmitKey(topicPublicKey); // Only holders of this key can submit messages

  const txResponse = await txCreateTopic.execute(client);
  const receipt = await txResponse.getReceipt(client);

  const topicId = receipt.topicId.toString();
  console.log("Private Topic ID:", topicId);
  console.log("Topic Submit Private Key:", topicPrivateKey.toString());
  console.log("Topic Submit Public Key:", topicPublicKey.toString());

  client.close();
}

main();
