# Bundled data

Responses recorded by `npm run record-data` for every piece's default knobs, gzipped and named by a hash of the request (`manifest.json` maps each to its content type). The app answers exactly these requests from here (see `src/lib/netcache.ts`). Anything else goes to the network.

The data belongs to its sources, under their own terms:

- **OpenStreetMap** data via Overpass: © OpenStreetMap contributors, available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
- **Terrain tiles:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). See their [attribution requirements](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (SRTM, GMTED, ETOPO1 and others).
- **Natural Earth** coastlines and borders: public domain.
- **Stars and constellations:** [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3-Clause).
- **Weather:** [Open-Meteo](https://open-meteo.com/), CC BY 4.0.
- **Earthquakes:** USGS. **Tides:** NOAA. Both public domain.
- **Routes:** [OSRM](https://project-osrm.org/) on OpenStreetMap data (ODbL).
- **GitHub contributions:** [github-contributions-api](https://github.com/grubersjoe/github-contributions-api).
