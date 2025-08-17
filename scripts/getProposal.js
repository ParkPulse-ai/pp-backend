// getProposal.js
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
  let client;
  try {
    const MY_ACCOUNT_ID = AccountId.fromString(process.env.OPERATOR_ID);
    const MY_PRIVATE_KEY = PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY);

    client = Client.forTestnet();
    client.setOperator(MY_ACCOUNT_ID, MY_PRIVATE_KEY);

    const contractId = process.env.CONTRACT_ID; // Replace with your deployed contract ID
    const totalProposals = 100; // Adjust based on max expected proposal ID

    console.log("Fetching proposals from contract:", contractId);

    for (let id = 1; id <= totalProposals; id++) {
      try {
        // Call getProposal(uint256 _proposalId)
        const query = new ContractCallQuery()
          .setContractId(contractId)
          .setGas(200_000)
          .setFunction(
            "getProposal",
            new ContractFunctionParameters().addUint256(id)
          );

        const result = await query.execute(client);

        // Decode Proposal struct and isActive
        const proposalId = result.getUint256(0);
        const parkName = result.getString(1);
        const message = result.getString(2);
        const parkSize = result.getUint256(3);
        const chatTopicHistory = result.getString(4);
        const creator = result.getAddress(5);
        const yesVotes = result.getUint256(6);
        const noVotes = result.getUint256(7);
        const deadline = result.getUint256(8);
        const isActive = result.getBool(9);

        console.log("------------------------------");
        console.log("Proposal ID         : ", proposalId);
        console.log("Park Name           : ", parkName);
        console.log("Message             : ", message);
        console.log("Park Size           : ", parkSize);
        console.log("Chat Topic History  : ", chatTopicHistory);
        console.log("Creator             : ", creator);
        console.log("Yes Votes           : ", yesVotes);
        console.log("No Votes            : ", noVotes);
        console.log(
          "Deadline            : ",
          new Date(deadline * 1000).toLocaleString()
        );
        console.log("Active              : ", isActive ? "Yes" : "No");
      } catch (err) {
        // Proposal does not exist, skip
        // console.log(`Proposal ${id} not found`);
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (client) client.close();
  }
}

main();
