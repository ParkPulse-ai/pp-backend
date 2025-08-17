import "dotenv/config";
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { ChatOpenAI } from "@langchain/openai";
import fetch from "node-fetch";

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
You are a highly capable urban planning and environmental assistant integrated into a GIS-aware chatbot interface. 
Your role is to interpret natural language queries and return STRICT JSON in the following structure:
{
  "intent": "show_parks" | "ask_area" | "greeting" | "unknown" | "park_removal_impact" | "park_ndvi_query" | "park_stat_query",
  "locationType": "zip" | "city" | "state" | null,
  "locationValue": string | null,
  "unit": "acres" | "m2" | "km2" | "hectares" | null,
  "landUseType": "removed" | "replaced_by_building" | null
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
- "hello" => greeting

Respond with ONLY the JSON, no explanation or comments.`;

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
        Park_Local: r.park_local,
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
        park_local,
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
    console.log(parkId)
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
console.log(geeResp)
console.log(park_name)
console.log(parkId)
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
      formatted: Number(val).toLocaleString()
    };
  } finally {
    client.release();
  }
}

async function getParkNDVI(parkId) {
  const client = await pool.connect();
  try {
    const sql = `SELECT ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geometry FROM parks WHERE park_id = $1`;
    const { rows } = await client.query(sql, [parkId]);
    if (!rows.length) throw new Error("Park not found");
    const geojson = rows[0].geometry;
console.log(geojson)
    const response = await fetch("http://localhost:5001/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geojson, landUseType: "existing" })
    });

    const result = await response.json();
    console.log(result)
    return result.ndviBefore;
  } finally {
    client.release();
  }
}

// --- Agent endpoint (LLM decides; server executes) ---
app.post("/api/agent", async (req, res) => {
  try {
    const { message, uiContext } = req.body || {};
    const selectedParkId = uiContext?.selectedParkId || null;

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

    if (parsed.intent === "show_parks") {
      const q = { zip: null, city: null, state: null };
      if (parsed.locationType === "zip") q.zip = parsed.locationValue;
      if (parsed.locationType === "city") q.city = parsed.locationValue;
      if (parsed.locationType === "state") q.state = parsed.locationValue;

      const fc = await queryParksByLocation(q);
      return res.json({
        action: "render_parks",
        reply: `Loaded ${fc.features.length} park(s) for ${parsed.locationType}: ${parsed.locationValue}.`,
        data: { featureCollection: fc },
      });
    }

    if (parsed.intent === "ask_area") {
      if (!selectedParkId) {
        return res.json({
          action: "need_selection",
          reply: "Please click a park first.",
        });
      }

      const info = await queryParkAreaById(selectedParkId);
      if (!info)
        return res.json({
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

      return res.json({
        action: "answer",
        reply: `Area of "${info.name}": ${formatted} ${unitLabel}.`,
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
          action: "need_selection",
          reply: "Please select a park to analyze its removal impact.",
        });
      }
      const impact = await analyzeParkRemovalImpact(
        selectedParkId,
        parsed.landUseType || "removed"
      );
      return res.json({
        action: "removal_impact",
        reply: impact.message,
        data: impact,
      });
    }

    if (parsed.intent === "park_ndvi_query") {
      if (!selectedParkId)
        return res.json({
          action: "need_selection",
          reply: "Please select a park.",
        });

      const ndvi = await getParkNDVI(selectedParkId);
      return res.json({
        action: "answer",
        reply: `The NDVI of this park is approximately ${ndvi.toFixed(3)}.`,
        data: { ndvi },
      });
    }

    if (parsed.intent === "park_stat_query") {
      if (!selectedParkId)
        return res.json({
          action: "need_selection",
          reply: "Please select a park.",
        });
      if (!parsed.metric)
        return res.json({ action: "error", reply: "Metric not specified." });

      const stat = await queryParkStatById(selectedParkId, parsed.metric);
      return res.json({
        action: "answer",
        reply: `The value for ${parsed.metric} is ${stat.formatted}.`,
        data: { metric: parsed.metric, value: stat.value },
      });
    }

    if (parsed.intent === "greeting") {
      return res.json({
        action: "answer",
        reply:
          "Hello! Try: “show parks of zipcode 20008” or “show parks of city Austin”.",
      });
    }

    return res.json({
      action: "answer",
      reply:
        "I can show parks by zipcode/city/state, or tell you the area of a clicked park.",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ action: "error", reply: "Server error." });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Backend (PostGIS) on http://localhost:${PORT}`)
);
