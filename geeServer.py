import json
import ee
from flask import Flask, request, jsonify

# Initialize Earth Engine
ee.Initialize()
app = Flask(__name__)

def geometry_from_geojson(geojson):
    return ee.Geometry(geojson)

def compute_ndvi(geometry):
    collection = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2") \
        .filterBounds(geometry) \
        .filterDate("2022-06-01", "2022-09-01") \
        .sort("CLOUD_COVER") \
        .map(lambda img: img.multiply(0.0000275).add(-0.2))

    def add_ndvi(image):
        return image.addBands(image.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI'))

    ndvi_img = collection.map(add_ndvi).select('NDVI').median()
    stats = ndvi_img.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=geometry,
        scale=30,
        maxPixels=1e9
    )
    return stats.getInfo().get('NDVI', None)

def compute_walkability(geometry):
    population = ee.ImageCollection("WorldPop/GP/100m/pop").first()
    stats = population.reduceRegion(
        reducer=ee.Reducer.sum(),
        geometry=geometry,
        scale=100,
        maxPixels=1e9
    )
    total_pop = stats.getInfo().get('population', 0)
    area_km2 = geometry.area().getInfo() / 1e6
    density = total_pop / area_km2 if area_km2 > 0 else 0
    score = 100 / (1 + pow(2.71828, -0.03 * (density - 100)))
    return round(score, 2)

def compute_pm25(geometry):
    pm25 = ee.ImageCollection("COPERNICUS/S5P/NRTI/L3_AER_AI") \
        .filterBounds(geometry) \
        .filterDate("2022-06-01", "2022-09-01") \
        .select("absorbing_aerosol_index") \
        .median()

    stats = pm25.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=geometry,
        scale=1000,
        maxPixels=1e9
    )
    return stats.getInfo().get("absorbing_aerosol_index", None)

def compute_population(geometry):
    buffer = geometry.buffer(800)
    population = ee.ImageCollection("WorldPop/GP/100m/pop").first()
    stats = population.reduceRegion(
        reducer=ee.Reducer.sum(),
        geometry=buffer,
        scale=100,
        maxPixels=1e9
    )
    return stats.getInfo().get('population', 0)

def simulate_replacement_with_buildings(buffer_geom, park_geom):
    built_ndvi = ee.Image.constant(0.1).rename('NDVI')
    ndvi_img = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2") \
        .filterBounds(buffer_geom) \
        .filterDate("2022-06-01", "2022-09-01") \
        .sort("CLOUD_COVER") \
        .map(lambda img: img.multiply(0.0000275).add(-0.2)) \
        .map(lambda img: img.addBands(img.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI'))) \
        .median() \
        .select('NDVI')

    modified_ndvi = ndvi_img.blend(built_ndvi.clip(park_geom))

    stats = modified_ndvi.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=buffer_geom,
        scale=30,
        maxPixels=1e9
    )
    return stats.getInfo().get('NDVI', None)

@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        data = request.get_json()
        geojson = data.get("geometry")
        land_use_type = data.get("landUseType", "removed")
        
        print(geojson)

        if not geojson:
            return jsonify({"error": "Missing geometry"}), 400

        park_geom = geometry_from_geojson(geojson)
        buffer_geom = park_geom.buffer(800)

        ndvi_before = compute_ndvi(buffer_geom)
        walkability_before = compute_walkability(buffer_geom)
        pm25_before = compute_pm25(buffer_geom)
        affected_population = compute_population(buffer_geom)

        if land_use_type == "removed":
            buffer_after = buffer_geom.difference(park_geom)
            ndvi_after = compute_ndvi(buffer_after)
        elif land_use_type == "replaced_by_building":
            ndvi_after = simulate_replacement_with_buildings(buffer_geom, park_geom)
        else:
            ndvi_after = ndvi_before

        walkability_after = compute_walkability(buffer_geom.difference(park_geom))
        pm25_after = compute_pm25(buffer_geom.difference(park_geom))

        return jsonify({
            "affectedPopulation10MinWalk": int(affected_population),
            "ndviBefore": round(ndvi_before, 4) if ndvi_before else None,
            "ndviAfter": round(ndvi_after, 4) if ndvi_after else None,
            "walkabilityBefore": walkability_before,
            "walkabilityAfter": walkability_after,
            "pm25Before": round(pm25_before, 2) if pm25_before else None,
            "pm25After": round(pm25_after, 2) if pm25_after else None
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/ndvi", methods=["POST"])
def ndvi():
    try:
        data = request.get_json()
        geojson = data.get("geometry")

        if not geojson:
            return jsonify({"error": "Missing geometry"}), 400

        geometry = geometry_from_geojson(geojson)
        ndvi_value = compute_ndvi(geometry)

        return jsonify({
            "ndvi": round(ndvi_value, 4) if ndvi_value is not None else None
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(port=5001, debug=True)
