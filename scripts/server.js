import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import {
  Client,
  ContractExecuteTransaction,
  ContractCallQuery,
} from "@hashgraph/sdk";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Hedera client setup
const client = Client.forTestnet();
client.setOperator(process.env.OPERATOR_ID, process.env.OPERATOR_KEY);

const contractId = process.env.CONTRACT_ID;

// --------- ENDPOINTS ---------

import {
  ContractFunctionParameters,
  ContractExecuteTransaction,
} from "@hashgraph/sdk";

// Create a proposal
app.post("/proposal", async (req, res) => {
  try {
    const { proposalId, description } = req.body;

    // Deadline = 5 minutes from now (UNIX timestamp in seconds)
    const deadline = Math.floor(Date.now() / 1000) + 5 * 60;

    const tx = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(100000)
      .setFunction(
        "createProposal",
        new ContractFunctionParameters()
          .addUint256(proposalId)
          .addString(description)
          .addUint256(deadline)
      )
      .execute(client);

    const receipt = await tx.getReceipt(client);

    res.json({ status: receipt.status.toString(), proposalId, deadline });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Vote on a proposal
app.post("/vote", async (req, res) => {
  try {
    const { proposalId, support } = req.body;

    const tx = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(100000)
      .setFunction("vote", [
        { type: "uint256", value: proposalId },
        { type: "bool", value: support },
      ])
      .execute(client);

    const receipt = await tx.getReceipt(client);
    res.json({ status: receipt.status.toString(), proposalId, voted: support });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Get proposal info
app.get("/proposal/:id", async (req, res) => {
  try {
    const proposalId = parseInt(req.params.id);

    const query = new ContractCallQuery()
      .setContractId(contractId)
      .setGas(100000)
      .setFunction("getProposal", [{ type: "uint256", value: proposalId }]);

    const result = await query.execute(client);

    const proposal = {
      id: result.getUint256(0),
      description: result.getString(1),
      creator: result.getAddress(2),
      yesVotes: result.getUint256(3),
      noVotes: result.getUint256(4),
      deadline: result.getUint256(5),
    };

    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// --------- START SERVER ---------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hedera voting server running on http://localhost:${PORT}`);
});
