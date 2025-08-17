import {
  AccountId,
  PrivateKey,
  Client,
  ContractCallQuery,
  ContractFunctionParameters,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
import fetch from "node-fetch"; // npm install node-fetch

dotenv.config();

async function main() {
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(process.env.OPERATOR_ID),
    PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY)
  );

  const contractId = process.env.CONTRACT_ID;
  const publisher = process.env.PUBLISHER; // Walrus endpoint

  try {
    // 1. Get total proposals
    const totalQuery = new ContractCallQuery()
      .setContractId(contractId)
      .setGas(100_000)
      .setFunction("getTotalProposals");
    const totalResult = await totalQuery.execute(client);
    const totalProposals = totalResult.getUint256(0).toNumber();
    console.log("Total proposals:", totalProposals);

    let inactiveProposals = [];

    // 2. Loop over each proposal
    for (let proposalId = 1; proposalId <= totalProposals; proposalId++) {
      const propQuery = new ContractCallQuery()
        .setContractId(contractId)
        .setGas(200_000)
        .setFunction(
          "getProposal",
          new ContractFunctionParameters().addUint256(proposalId)
        );

      const propResult = await propQuery.execute(client);

      const id = propResult.getUint256(0).toNumber();
      const parkName = propResult.getString(1);
      const message = propResult.getString(2);
      const parkSize = propResult.getUint256(3).toNumber();
      const chatTopicHistory = propResult.getString(4);
      const creator = propResult.getAddress(5);
      const yesVotes = propResult.getUint256(6).toNumber();
      const noVotes = propResult.getUint256(7).toNumber();
      const deadline = propResult.getUint256(8).toNumber();
      const isActive = propResult.getBool(9);

      if (!isActive) {
        // Fetch voters list
        const votersQuery = new ContractCallQuery()
          .setContractId(contractId)
          .setGas(200_000)
          .setFunction(
            "getVoters",
            new ContractFunctionParameters().addUint256(proposalId)
          );
        const votersResult = await votersQuery.execute(client);

        const encoded = votersResult.bytes;
        const voters = [];
        for (let i = 0; i < encoded.length; i += 32) {
          const addressBytes = encoded.slice(i + 12, i + 32);
          if (addressBytes.length === 20) {
            const hex = "0x" + Buffer.from(addressBytes).toString("hex");
            voters.push(hex);
          }
        }

        inactiveProposals.push({
          proposalId: id,
          parkName,
          message,
          parkSize,
          chatTopicHistory,
          creator,
          yesVotes,
          noVotes,
          deadline,
          voters,
        });
      }
    }

    const jsonData = JSON.stringify(inactiveProposals, null, 2);

    // Print JSON before uploading
    console.log("\n📦 Inactive Proposals JSON:\n", jsonData);

    // 3. Upload to Walrus
    console.log("\nUploading JSON to Walrus…");
    const response = await fetch(`${publisher}/v1/blobs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: jsonData,
    });

    if (!response.ok) {
      throw new Error(`Walrus upload failed: ${response.statusText}`);
    }

    // 4. Extract and print only the blobId
    const rawText = await response.text();
    console.log("\n📥 Raw Walrus Response:\n", rawText);

    try {
      const data = JSON.parse(rawText);
      const blobId = data?.alreadyCertified?.blobId;
      console.log("\n✅ Extracted Blob ID:", blobId);
    } catch (parseErr) {
      console.error("Failed to parse Walrus response as JSON:", parseErr);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    client.close();
  }
}

main();
