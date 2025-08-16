import "dotenv/config";
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { ChatOpenAI } from "@langchain/openai";

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
You are a parks assistant for a chat application. Return STRICT JSON:
{
  "intent": "show_parks" | "ask_area" | "greeting" | "unknown",
  "locationType": "zip" | "city" | "state" | null,
  "locationValue": string | null,
  "unit": "acres" | "m2" | "km2" | "hectares" | null
}
Examples:
- "show parks of zipcode 20008" => show_parks, zip, 20008
- "show parks of city Austin"   => show_parks, city, Austin
- "give me area of this park"   => ask_area
- "how big is this park in square meters?" => ask_area, unit: "m2"
- "Greetings" => greeting
Output only the JSON.
`;

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
      WHERE gid = $1
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
