import "dotenv/config";
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { ChatOpenAI } from "@langchain/openai";
import fetch from "node-fetch";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  AccountId,
  PrivateKey,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractCallQuery,
  TransferTransaction
} from "@hashgraph/sdk";
import {
  HederaLangchainToolkit,
  coreQueriesPlugin,
  coreConsensusPlugin,
} from "hedera-agent-kit";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

const LLM = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });

const SYSTEM = `
You are a highly capable urban planning and blockchain-integrated assistant embedded in a GIS-aware chatbot.
Your role is to interpret natural language queries and return STRICT JSON in the following structure:
{
  "intent": "show_parks" | "ask_area" | "greeting" | "unknown" | "park_removal_impact" | "park_ndvi_query" | "park_stat_query" | "get_hedera_balance" | "create_hedera_token" | "hedera_transaction" | "get_token_info" | "proposal",
  "locationType": "zip" | "city" | "state" | null,
  "locationValue": string | null,
  "unit": "acres" | "m2" | "km2" | "hectares" | null,
  "landUseType": "removed" | "replaced_by_building" | null,
  "metric": string | null
}

Examples:
- "show parks in Austin" => show_parks, city: Austin
- "show parks of zipcode 20008" => show_parks, zip, 20008
- "give me area of this park" => ask_area
- "how big is this park in hectares" => ask_area, unit: hectares
- "what is the area in square meters?" => ask_area, unit: "m2"
- "What happens if this park is removed?" => park_removal_impact, landUseType: removed
- "Replace this park with commercial buildings" => park_removal_impact, landUseType: replaced_by_building
- "what's the NDVI of this park?" => intent: "park_ndvi_query"
- "how many Asian people are served by this park?" => intent: "park_stat_query", metric: "SUM_ASIAN_"
- "what’s the total population in the park’s service area?" => intent: "park_stat_query", metric: "SUM_TOTPOP"
- "How many seniors are in this area?" => intent: "park_stat_query", metric: "SUM_SENIOR"
- "How many kids are in this area?" => intent: "park_stat_query", metric: "SUM_KIDSVC"
- "What’s the per acre density?" => intent: "park_stat_query", metric: "PERACRE"
- "what income group is most served here?" => intent: "park_stat_query", metric: "income_distribution"
- "how many Hispanic households are in the service area?" => intent: "park_stat_query", metric: "SUM_HISP_S"
- "propose this to the community and set deadline as one hour" => intent: "proposal"
- "hello" => greeting

Blockchain examples:
- "what is my Hedera balance?" => intent: "get_hedera_balance"
- "create a token for underserved parks" => intent: "create_hedera_token"
- "submit a Hedera transaction" => intent: "hedera_transaction"
- "get info for token 0.0.123456" => intent: "get_token_info"

Respond with ONLY the JSON, no explanation or comments.`;

const MY_ACCOUNT_ID = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
const MY_PRIVATE_KEY = PrivateKey.fromStringECDSA(
  process.env.HEDERA_PRIVATE_KEY
);

// Hedera Setup
const hederaClient = Client.forTestnet().setOperator(
  MY_ACCOUNT_ID,
  MY_PRIVATE_KEY
);

const hederaAgentToolkit = new HederaLangchainToolkit({
  client: hederaClient,
  configuration: { plugins: [coreQueriesPlugin, coreConsensusPlugin] },
});

const hederaTools = hederaAgentToolkit.getTools();

const hederaAgent = createToolCallingAgent({
  llm: LLM,
  tools: hederaTools,
  prompt: ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are a Hedera assistant helping users with blockchain actions.",
    ],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]),
});

const hederaExecutor = new AgentExecutor({
  agent: hederaAgent,
  tools: hederaTools,
});

let chatTopics = new Map();

// Build a FeatureCollection from rows (with geometry JSON already)
function buildFC(rows) {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: r.geometry,
      properties: {
        gid: r.gid,
        Park_id: r.park_id,
        Park_Name: r.park_name,
        Park_Addre: r.park_addre,
        Park_Owner: r.park_owner,
        Park_Zip: r.park_zip,
        Park_Size_Acres: r.area_acres,
      },
    })),
  };
}

// Filtering by zip/city/state; simplifying geometry for map
async function queryParksByLocation({
  zip,
  city,
  state,
  simplifyTolerance = 0.0002,
}) {
  // Tolerance ~0.0002 degrees ≈ 20 m; tweak per scale
  const client = await pool.connect();
  try {
    let where = [];
    let params = [];
    if (zip) {
      params.push(zip);
      where.push(`park_zip = $${params.length}`);
    }
    if (city) {
      params.push(city);
      where.push(`LOWER(park_place) = LOWER($${params.length})`);
    }
    if (state) {
      params.push(state);
      where.push(`LOWER(park_state) = LOWER($${params.length})`);
    }
    if (where.length === 0) where.push("1=0");

    const sql = `
      SELECT
        gid,
        park_id,
        park_name,
        park_addre,
        park_owner,
        park_zip,
        COALESCE(park_size_, NULLIF(shape_area,0) * 0.000247105,
                 ST_Area(geography(geom)) * 0.000247105) AS area_acres,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Transform(geom, 4326), $${
          params.length + 1
        }))::json AS geometry
      FROM parks
      WHERE ${where.join(" OR ")}
      LIMIT 5000;
    `;

    const res = await client.query(sql, [...params, simplifyTolerance]);
    return buildFC(res.rows);
  } finally {
    client.release();
  }
}

async function queryParkAreaById(id) {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT park_name,
             COALESCE(park_size_, NULLIF(shape_area,0) * 0.000247105,
                      ST_Area(geography(geom)) * 0.000247105) AS area_acres
      FROM parks
      WHERE park_id = $1
      LIMIT 1;
    `;
    const { rows } = await client.query(sql, [id]);
    if (rows.length === 0) return null;
    return {
      name: rows[0].park_name || "Unnamed Park",
      acres: rows[0].area_acres,
    };
  } finally {
    client.release();
  }
}

async function getParkStatisticsById(parkId) {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT SUM_TOTPOP, SUM_KIDSVC, SUM_YOUNGP, SUM_SENIOR,
             SUM_HHILOW, SUM_HHIMED, SUM_HHIHIG, SUM_TOTHHS,
             SUM_WHITE_, SUM_BLACK_, SUM_ASIAN_, SUM_HISP_S,
             PERACRE
      FROM parks_stats
      WHERE park_id = $1
    `;
    const { rows } = await client.query(sql, [parkId]);
    return rows.length ? rows[0] : null;
  } finally {
    client.release();
  }
}

async function analyzeParkRemovalImpact(parkId, landUseType = "removed") {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT park_name, ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
      FROM parks_stats
      WHERE park_id = $1
    `;
    console.log(parkId);
    const { rows } = await client.query(sql, [parkId]);
    if (!rows.length) return null;
    const { park_name, geometry } = rows[0];

    const [geeResp, stats] = await Promise.all([
      fetch("http://localhost:5001/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geometry, landUseType }),
      }).then((r) => r.json()),
      getParkStatisticsById(parkId),
    ]);

    if (geeResp.error) throw new Error(geeResp.error);
    console.log(geeResp);
    console.log(park_name);
    console.log(parkId);
    return {
      parkId,
      parkName: park_name,
      landUseType,
      ...geeResp,
      demographics: {
        total: stats.sum_totpop,
        kids: stats.sum_kidsvc,
        adults: stats.sum_youngp,
        seniors: stats.sum_senior,
        white: stats.sum_white_,
        black: stats.sum_black_,
        asian: stats.sum_asian_,
        hispanic: stats.sum_hisp_s,
      },
      income: {
        low: stats.sum_hhilow,
        middle: stats.sum_hhimed,
        high: stats.sum_hhihig,
      },
      households: stats.sum_tothhs,
      perAcreDemand: stats.peracre,
      message: `If ${park_name} is ${landUseType.replaceAll("_", " ")}, ${
        stats.sum_totpop
      } people lose access. NDVI drops from ${geeResp.ndviBefore} to ${
        geeResp.ndviAfter
      }, PM2.5 may increase, and walkability decreases.`,
    };
  } finally {
    client.release();
  }
}

async function queryParkStatById(id, metric) {
  const client = await pool.connect();
  try {
    let field = metric;
    const sql = `SELECT ${field} FROM parks_stats WHERE park_id = $1 LIMIT 1`;
    const { rows } = await client.query(sql, [id]);
    if (!rows.length) return null;

    const val = rows[0][field.toLowerCase()];
    return {
      value: val,
      formatted: Number(val).toLocaleString(),
    };
  } finally {
    client.release();
  }
}

async function getParkNDVI(parkId) {
  const client = await pool.connect();
  try {
    const sql = `SELECT ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry FROM parks WHERE park_id = $1`;
    const { rows } = await client.query(sql, [parkId]);
    if (!rows.length) throw new Error("Park not found");
    const geojson = rows[0].geometry;
    console.log(geojson);
    const response = await fetch("http://localhost:5001/ndvi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geojson }),
    });

    const result = await response.json();
    console.log(result);
    return result.ndvi;
  } finally {
    client.release();
  }
}

async function pushToHederaTopic(topicId, message) {
  if (!topicId) return;
  await hederaExecutor.invoke({
    input: `submit a message to ${topicId} with ${message}`,
  });
}

function extractTopicIdString(text) {
  const start = text.indexOf("**") + 2;
  const end = text.lastIndexOf("**");
  return start > 1 && end > start ? text.substring(start, end) : null;
}

// --- Agent endpoint (LLM decides; server executes) ---
app.post("/api/agent", async (req, res) => {
  try {
    const { message, uiContext, sessionId } = req.body || {};
    const selectedParkId = uiContext?.selectedParkId || null;
    var topicId = 0;
    // Use provided sessionId or generate a new 6-digit one
    const finalSessionId =
      sessionId || `${Math.floor(100000 + Math.random() * 900000)}`;

    var msgProp = "";

    // Create topic if session is new
    if (!chatTopics.has(finalSessionId)) {
      const response = await hederaExecutor.invoke({
        input:
          "create a new topic for ParkPulse Ai and just return the topic id",
      });
      console.log(response);
      topicId = extractTopicIdString(response.output);
      chatTopics.set(finalSessionId, topicId);
    }
    if (topicId === 0) {
      topicId = chatTopics.get(finalSessionId);
    }

    // Log user message
    await hederaExecutor.invoke({
      input: `submit a message to ${topicId} with ${message}`,
    });

    const out = await LLM.invoke([
      { role: "system", content: SYSTEM },
      { role: "user", content: String(message || "") },
    ]);

    let parsed = {
      intent: "unknown",
      locationType: null,
      locationValue: null,
      unit: null,
      landUseType: null,
    };
    try {
      parsed = JSON.parse(out.content);
    } catch {}

    console.log(parsed.intent);

    let agentReply =
      "I can show parks by zipcode/city/state, or tell you the area of a clicked park.";

    if (
      [
        "get_hedera_balance",
        "create_hedera_token",
        "hedera_transaction",
        "get_token_info",
      ].includes(parsed.intent)
    ) {
      const result = await hederaExecutor.invoke({ input: message });
      agentReply = result.output || "Hedera response complete.";
      responsePayload = {
        action: "hedera_result",
        reply: agentReply,
        data: result,
      };
    }

    if (parsed.intent === "show_parks") {
      const q = { zip: null, city: null, state: null };
      if (parsed.locationType === "zip") q.zip = parsed.locationValue;
      if (parsed.locationType === "city") q.city = parsed.locationValue;
      if (parsed.locationType === "state") q.state = parsed.locationValue;

      const fc = await queryParksByLocation(q);
      const reply = `Loaded ${fc.features.length} park(s) for ${parsed.locationType}: ${parsed.locationValue}.`;
      await pushToHederaTopic(topicId, reply);

      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "render_parks",
        reply,
        data: { featureCollection: fc },
      });
    }

    if (parsed.intent === "ask_area") {
      if (!selectedParkId) {
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "need_selection",
          reply: "Please click a park first.",
        });
      }

      const info = await queryParkAreaById(selectedParkId);
      if (!info)
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "error",
          reply: "Could not find that park.",
        });

      let value = info.acres;
      let unit = parsed.unit || "acres";
      let converted = value;
      let unitLabel = "acres";

      if (unit === "m2") {
        converted = value * 4046.86;
        unitLabel = "m²";
      } else if (unit === "km2") {
        converted = value * 0.00404686;
        unitLabel = "km²";
      } else if (unit === "hectares") {
        converted = value * 0.404686;
        unitLabel = "hectares";
      }

      const formatted = Number(converted).toLocaleString(undefined, {
        maximumFractionDigits: 2,
      });

      const reply = `Area of "${info.name}": ${formatted} ${unitLabel}.`;
      await pushToHederaTopic(topicId, reply);

      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "answer",
        reply,
        data: {
          parkId: selectedParkId,
          area: converted,
          unit: unitLabel,
        },
      });
    }

    if (parsed.intent === "park_removal_impact") {
      if (!selectedParkId) {
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "need_selection",
          reply: "Please select a park to analyze its removal impact.",
        });
      }
      const impact = await analyzeParkRemovalImpact(
        selectedParkId,
        parsed.landUseType || "removed"
      );

      msgProp = impact.message;

      await pushToHederaTopic(topicId, impact.message);
      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "removal_impact",
        reply: impact.message,
        data: impact,
      });
    }

    if (parsed.intent === "park_ndvi_query") {
      if (!selectedParkId)
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "need_selection",
          reply: "Please select a park.",
        });

      const ndvi = await getParkNDVI(selectedParkId);
      const reply = `The NDVI of this park is approximately ${ndvi.toFixed(
        3
      )}.`;
      await pushToHederaTopic(topicId, reply);
      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "answer",
        reply,
        data: { ndvi },
      });
    }

    if (parsed.intent === "park_stat_query") {
      if (!selectedParkId)
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "need_selection",
          reply: "Please select a park.",
        });
      if (!parsed.metric)
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "error",
          reply: "Metric not specified.",
        });

      const stat = await queryParkStatById(selectedParkId, parsed.metric);
      const reply = `The value for ${parsed.metric} is ${stat.formatted}.`;
      await pushToHederaTopic(topicId, reply);
      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "answer",
        reply,
        data: { metric: parsed.metric, value: stat.value },
      });
    }

    if (parsed.intent === "proposal") {
      if (!selectedParkId) {
        return res.json({
          topicId: topicId,
          sessionId: finalSessionId,
          action: "need_selection",
          reply: "Please select a park to propose a change for.",
        });
      }

      const info = await queryParkAreaById(selectedParkId);
      const parkName = info?.name || "Unnamed Park";
      const parkSize = Math.round(info?.acres || 0);

      const impactt = await analyzeParkRemovalImpact(
        selectedParkId,
        "replaced_by_building"
      );

      const lastMessage = impactt.message;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const proposal = {
        parkId: selectedParkId,
        parkName,
        message: lastMessage,
        parkSize,
        chatTopicId: topicId,
        deadline: deadline,
      };

      const txContractExecute = new ContractExecuteTransaction()
        .setContractId(process.env.CONTRACT_ID)
        .setGas(500_000)
        .setFunction(
          "createProposal",
          new ContractFunctionParameters()
            .addString(parkName)
            .addString(lastMessage)
            .addUint256(parkSize)
            .addString(topicId)
            .addUint256(deadline)
        );
      const query = new ContractCallQuery()
        .setContractId(process.env.CONTRACT_ID)
        .setGas(100_000)
        .setFunction("proposalCount");

      const queryResult = await query.execute(hederaClient);
      const proposalId = queryResult.getUint256(0).toNumber();
      const txResponse = await txContractExecute.execute(hederaClient);
      const receipt = await txResponse.getReceipt(hederaClient);
      console.log("------------------- Proposal Created -------------------");
      console.log("Transaction ID: ", txResponse.transactionId.toString());
      console.log("Status: ", receipt.status.toString());
      console.log(
        "Hashscan URL: https://hashscan.io/testnet/tx/" +
          txResponse.transactionId.toString()
      );

      const proposalMessage = `Proposal (ID - ${proposalId}): "${parkName}" – "${lastMessage}"\nSize: ${parkSize} acres\nDeadline: ${proposal.deadline}`;
      await pushToHederaTopic(topicId, proposalMessage);
      await pushToHederaTopic("0.0.6594180", proposalMessage);

      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "proposal_created",
        reply: `Proposal for "${parkName}" submitted to the community. Voting closes by ${proposal.deadline}.`,
        data: proposal,
      });
    }

    if (parsed.intent === "greeting") {
      const reply =
        "Hello! Try: “show parks of zipcode 20008” or “show parks of city Austin”.";
      await pushToHederaTopic(topicId, reply);
      return res.json({
        topicId: topicId,
        sessionId: finalSessionId,
        action: "answer",
        reply,
      });
    }

    const fallbackReply =
      "I can show parks by zipcode/city/state, or tell you the area of a clicked park.";
    await pushToHederaTopic(topicId, fallbackReply);
    return res.json({
      topicId: topicId,
      sessionId: finalSessionId,
      action: "answer",
      reply: fallbackReply,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ action: "error", reply: "Server error." });
  }
});

// Helper function to calculate time left for proposals
function calculateTimeLeft(deadlineTimestamp) {
  const now = Math.floor(Date.now() / 1000);
  const timeLeft = deadlineTimestamp - now;

  if (timeLeft <= 0) return "Expired";

  const days = Math.floor(timeLeft / (24 * 60 * 60));
  const hours = Math.floor((timeLeft % (24 * 60 * 60)) / (60 * 60));

  if (days > 0) return `${days} day${days > 1 ? "s" : ""} left`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} left`;
  return "Less than 1 hour left";
}

// --- Proposals endpoint ---
app.get("/api/proposals", async (req, res) => {
  let client;
  try {
    // Use your secure environment variables
    const MY_ACCOUNT_ID = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
    const MY_PRIVATE_KEY = PrivateKey.fromStringECDSA(
      process.env.HEDERA_PRIVATE_KEY
    );

    client = Client.forTestnet();
    client.setOperator(MY_ACCOUNT_ID, MY_PRIVATE_KEY);

    const contractId = process.env.CONTRACT_ID;
    const totalProposals = 20;
    const proposals = [];

    for (let id = 1; id <= totalProposals; id++) {
      try {
        const query = new ContractCallQuery()
          .setContractId(contractId)
          .setGas(200_000)
          .setFunction(
            "getProposal",
            new ContractFunctionParameters().addUint256(id)
          );

        const result = await query.execute(client);

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

        if (isActive) {
          proposals.push({
            id: proposalId.toNumber(),
            title: parkName || `Park Proposal #${proposalId}`,
            description: message || "No description provided",
            location: `Park Size: ${parkSize} sq ft`,
            status: "Active Voting",
            votes: {
              yes: yesVotes.toNumber(),
              no: noVotes.toNumber(),
            },
            timeLeft: calculateTimeLeft(deadline.toNumber()),
            creator: creator,
            deadline: deadline.toNumber(),
            chatTopicHistory: chatTopicHistory,
            parkSize: parkSize.toNumber(),
          });
        }
      } catch (err) {
        continue;
      }
    }

    res.json({ success: true, proposals });
  } catch (error) {
    console.error("Error fetching proposals:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch proposals",
    });
  } finally {
    if (client) client.close();
  }
});

app.post("/api/vote", async (req, res) => {
  console.log("hererere");
  var { proposalId, vote, voterAddress } = req.body;
  if (
    typeof vote !== "boolean" ||
    !voterAddress ||
    typeof proposalId !== "number"
  ) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid parameters" });
  }

  let client;
  try {
    client = Client.forTestnet().setOperator(
      AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
      PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY)
    );

    const contractId = process.env.CONTRACT_ID;

    // Prepare transaction to call vote(proposalId, vote, voterAddress)
    const tx = new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(500_000)
      .setFunction(
        "vote",
        new ContractFunctionParameters()
          .addUint256(proposalId)
          .addBool(vote)
          .addAddress(AccountId.fromString(voterAddress).toSolidityAddress())
      );

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);

    const txId = response.transactionId.toString();
    const status = receipt.status.toString();

    console.log("----------- Vote Submitted -----------");
    console.log("Proposal ID  :", proposalId);
    console.log("Voter Address:", voterAddress);
    console.log("Vote         :", vote ? "Yes" : "No");
    console.log("Status       :", status);
    console.log("Tx Hashscan  :", `https://hashscan.io/testnet/tx/${txId}`);

    const txTransfer = await new TransferTransaction()
      .addTokenTransfer(
        '0.0.6596379',
        AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
        -5
      ) //Fill in the token ID
      .addTokenTransfer('0.0.6596379', AccountId.fromString("0.0.6590812"), 5) //Fill in the token ID and receiver account
      .freezeWith(client);

    //Sign with the sender account private key
    const signTxTransfer = await txTransfer.sign(MY_PRIVATE_KEY);

    //Sign with the client operator private key and submit to a Hedera network
    const txTransferResponse = await signTxTransfer.execute(client);

    //Request the receipt of the transaction
    const receiptTransferTx = await txTransferResponse.getReceipt(client);

    //Obtain the transaction consensus status
    const statusTransferTx = receiptTransferTx.status;

    //Get the Transaction ID
    const txTransferId = txTransferResponse.transactionId.toString();

    console.log(
      "--------------------------------- Token Transfer ---------------------------------"
    );
    console.log("Receipt status           :", statusTransferTx.toString());
    console.log("Transaction ID           :", txTransferId);
    console.log(
      "Hashscan URL             :",
      "https://hashscan.io/testnet/tx/" + txTransferId
    );

    return res.json({
      success: true,
      message: `Vote ${
        vote ? "Yes" : "No"
      } submitted for Proposal ${proposalId}`,
      txId,
      status,
      hashscan: `https://hashscan.io/testnet/tx/${txId}`,
    });
  } catch (error) {
    console.error("Voting error:", error);
    return res.status(500).json({ success: false, error: "Failed to vote" });
  } finally {
    if (client) client.close();
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Backend (PostGIS) on http://localhost:${PORT}`)
);
