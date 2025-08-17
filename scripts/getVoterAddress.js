import {
  AccountId,
  PrivateKey,
  Client,
  ContractCallQuery,
  ContractFunctionParameters,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(process.env.OPERATOR_ID),
    PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY)
  );

  const contractId = process.env.CONTRACT_ID;
  const proposalId = 2; // proposal ID to fetch voters

  try {
    const query = new ContractCallQuery()
      .setContractId(contractId)
      .setGas(100_000)
      .setFunction(
        "getVoters",
        new ContractFunctionParameters().addUint256(proposalId)
      );

    const result = await query.execute(client);

    // decode the bytes into array of addresses
    const encoded = result.bytes; // returns Uint8Array
    const voters = []; // decoded voter addresses

    // Solidity returns 32-byte entries per address (padded)
    for (let i = 0; i < encoded.length; i += 32) {
      const addressBytes = encoded.slice(i + 12, i + 32); // last 20 bytes
      const hex = "0x" + Buffer.from(addressBytes).toString("hex");
      voters.push(hex);
    }

    console.log("Voter addresses for proposal", proposalId, ":", voters);
  } catch (err) {
    console.error("Error fetching voters:", err);
  } finally {
    client.close();
  }
}

main();
