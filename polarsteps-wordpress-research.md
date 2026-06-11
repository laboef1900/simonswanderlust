# Research: Polarsteps-like Travel Tracking for WordPress (simonswanderlust)

## The Short Answer

Yes, you can get Polarsteps-like features on WordPress through **3 approaches** -- existing plugins (quick), a standalone open-source app (medium), or a custom plugin (full control). No single WordPress plugin replicates Polarsteps completely.

---

## What Makes Polarsteps Special

- **Automatic GPS tracking** with offline capability, syncs when connectivity restored
- **Interactive map** with animated route lines between stops
- **Photo/video pins** geolocated on the map ("steps")
- **Trip timeline** -- chronological step-by-step narrative
- **Travel statistics** -- countries visited, distance covered, % of world explored
- **Travel book export** -- physical hardback book from your digital journey
- **Planning tools** -- itinerary and transport planner
- **Community features** -- curated guides, tips, following other travelers

**What makes it different from a blog**: Automation (GPS-based vs manual), map-centric UI (not text-heavy), structured step-based content, offline-first, integrated social.

**Data export**: JSON (comprehensive), photos, physical book, GPX/PDF via third-party tools.

**Built on**: [Mapbox](https://www.mapbox.com/showcase/polarsteps)

---

## Approach 1: Combine Existing WordPress Plugins (1-2 hours setup)

### Best Single Plugin: CM Routes Manager (~85% Polarsteps match)

- **URL**: [cminds.com](https://www.cminds.com/wordpress-plugins-library/google-maps-routes-manager-plugin-for-wordpress-by-creativeminds/)
- **Price**: $59 one-time
- **Features**:
  - GPX/KML/KMZ file import with route display
  - Google Maps (terrain, satellite, regular views)
  - Media-rich route pages (photos, videos, narrative text)
  - Elevation profiles and distance stats
  - Live weather updates on routes
  - Waze integration for directions
  - Social sharing (Strava, BuddyPress)
  - Guest submissions with moderation
  - Star-based rating system
- **Missing**: Automatic GPS tracking, animated timeline UI

### Free Plugin Combo

| Plugin | What It Does | Rating | Installs |
|--------|-------------|--------|----------|
| **[Travelers' Map](https://wordpress.org/plugins/travelers-map/)** | Blog posts as pins on Leaflet/OSM map, clustering, custom markers | 4.7/5 | Active |
| **[WP GPX Maps](https://wordpress.org/plugins/wp-gpx-maps/)** | GPX tracks with elevation graphs, NextGen Gallery photo integration | 4.2/5 | 4,000+ |
| **[Interactive Geo Maps](https://wordpress.org/plugins/interactive-geo-maps/)** | "Visited countries" SVG map, colored regions | Popular | Active |
| **[TravelMap](https://wordpress.org/plugins/travelmap-blog/)** | Route lines with transport-mode coloring, photo/post linking | Active | Free/EUR 30/yr |

### Hidden Gem: Fotorama-Leaflet-Elevation (Free)

- **GitHub**: [MartinvonBerg/Fotorama-Leaflet-Elevation](https://github.com/MartinvonBerg/Fotorama-Leaflet-Elevation)
- Photo slider that auto-syncs with a Leaflet map
- Click a photo -> map centers on that location
- Click a map marker -> slider jumps to that image
- Displays GPX tracks alongside photos
- **Closest to the Polarsteps "scroll through your trip" feel** (~75% match)

### Other Premium Options

| Plugin | Price | Key Feature |
|--------|-------|------------|
| **[Maps Marker Pro](https://www.mapsmarker.com/)** | EUR 39 one-time | GPX tracks + markers + multiple map providers |
| **[MapPress Pro](https://mappresspro.com/)** | $49.95-$79.95 | Google Maps + Leaflet, custom icons, GPX support |
| **[MapSVG](https://mapsvg.com/)** | Multi-tier | Vector maps, route tracking, elevation graphs |

### What This Combo Gets You vs What's Missing

**You get**: Post-linked map pins + GPX route display + visited-countries overview + photo-map sync

**Missing**: No unified Polarsteps-like timeline, no animated routes, no single integrated experience, no automatic GPS tracking

---

## Approach 2: Polarsteps Integration (Direct)

### Embed Polarsteps Trips

- Polarsteps has a **Share button** on the desktop site that provides a link you can embed
- Basic iframe, Polarsteps branding, minimal customization
- [Polarsteps embed support](https://support.polarsteps.com/article/171-can-i-embed-my-polarsteps-trip-on-my-website)

### WordPress Polarsteps Plugins

| Plugin | What It Does |
|--------|-------------|
| **[Polarsteps Integration (jan-muller)](https://github.com/jan-muller/polarsteps-integration)** | Auto-imports "Steps" as WordPress posts, hourly sync, first image as featured image |
| **[Integrate Polarsteps (npersonn)](https://github.com/npersonn/integrate-polarsteps)** | Widget showing last known location |

**Warning**: These use an **unofficial, undocumented API** that Polarsteps can break at any time. No official public API exists.

### Polarsteps Data Tools

- **[polarsteps-api (Python)](https://github.com/remuzel/polarsteps-api)** -- unofficial API wrapper
- **[polarsteps-data-parser](https://github.com/niekvleeuwen/polarsteps-data-parser)** -- parse/backup Polarsteps data export
- **[PolarSteps Processing (adamlporter)](https://github.com/adamlporter/PolarSteps)** -- Jupyter notebook to process JSON export

---

## Approach 3: AdventureLog -- Open-Source Alternative (4-8 hours)

**[AdventureLog](https://github.com/seanmorley15/AdventureLog)** -- 2,355+ GitHub stars, GPL v3

- **Tech stack**: SvelteKit + Django + PostgreSQL
- **Features**:
  - Interactive map with location tracking
  - Travel analytics (countries, regions, cities)
  - Multi-day itineraries with photos, notes, packing lists
  - Sharing and collaboration (public links or user-to-user)
  - Photo integration with Immich (self-hosted photo library)
  - Docker deployment
- **How to use with WordPress**: Run on a subdomain (e.g., `map.simonswanderlust.com`) and link/iframe from blog posts
- **Pros**: Most complete open-source Polarsteps alternative, self-hosted, actively maintained
- **Cons**: Separate app (not inside WordPress), requires Docker hosting

Also found: **[Trip (itskovacs)](https://github.com/itskovacs/trip)** -- minimalist POI map tracker, simpler but more limited.

---

## Approach 4: Build a Custom WordPress Plugin (40-80 hours)

### Recommended Tech Stack

| Component | Library | Cost |
|-----------|---------|------|
| Map rendering | **[Leaflet.js](https://leafletjs.com/)** (v1.9.x) | Free, BSD license |
| Map tiles | **[CARTO Voyager](https://carto.com/)** or OpenStreetMap | Free with attribution |
| GPX track rendering | **[leaflet-gpx](https://github.com/mpetazzoni/leaflet-gpx)** | Free |
| Animated routes | **[Leaflet.Polyline.SnakeAnim](https://github.com/IvanSanchez/Leaflet.Polyline.SnakeAnim)** | Free |
| Animated path effect | **[leaflet-ant-path](https://github.com/rubenspgcavalcante/leaflet-ant-path)** | Free |
| Timeline/carousel | **[Swiper.js](https://swiperjs.com/)** | Free |
| Photo GPS extraction | **[exifr](https://github.com/MikeKovarik/exifr)** (JS) or PHP `exif_read_data()` | Free |
| GPX parsing (JS) | **[gpxparser](https://www.npmjs.com/package/gpxparser)** or **[gpxjs](https://github.com/We-Gold/gpxjs)** | Free |

### Why Leaflet.js Over Alternatives

| Library | Cost | WordPress Viability | Notes |
|---------|------|-------------------|-------|
| **Leaflet.js** | Free | Excellent | No API keys, lightweight (42KB), huge plugin ecosystem |
| **MapLibre GL JS** | Free | Good | Open-source Mapbox fork, WebGL, vector tiles |
| **Mapbox GL JS** | Freemium | Poor | API key management issues for distributed plugins |
| **Google Maps API** | Pay-per-use | Very Poor | Requires billing account, expensive at scale |

### Plugin Architecture

```
wordpress-travel-map/
├── admin/
│   ├── trip-management.php     (CRUD interface)
│   ├── gpx-uploader.php        (GPX file handling)
│   └── settings.php            (plugin settings)
├── public/
│   ├── assets/
│   │   ├── leaflet.js          (map library)
│   │   ├── leaflet-gpx.js      (GPX rendering)
│   │   ├── custom-map.js       (main map logic)
│   │   └── timeline.js         (timeline UI)
│   ├── shortcodes.php          ([travel-map trip="123"])
│   └── templates/
│       ├── map-container.php
│       └── timeline.php
├── includes/
│   ├── class-trip.php          (custom post type)
│   ├── class-gps-parser.php    (GPX/EXIF parsing)
│   └── class-stats-calculator.php
└── plugin.php
```

### Data Storage: Custom Post Types (Recommended)

```php
// Trip post type
register_post_type('travel_trip', [
    'labels' => ['name' => 'Trips'],
    'public' => true,
    'supports' => ['title', 'editor', 'thumbnail'],
    'show_in_rest' => true,
]);
// Post meta: _trip_start_date, _trip_end_date, _trip_gpx_file, _trip_countries

// Stop post type
register_post_type('travel_stop', [
    'labels' => ['name' => 'Stops'],
    'public' => true,
    'show_in_rest' => true,
]);
// Post meta: _stop_trip_id, _stop_lat, _stop_lng, _stop_date, _stop_photos, _stop_description
```

### Development Effort Estimate

| Scope | Time | What You Get |
|-------|------|-------------|
| **Minimal** (static map + GPX + photo pins) | 2-3 weeks | Basic route display with markers |
| **Full** (timeline, animations, stats, admin UI) | 6-8 weeks | Complete Polarsteps-like experience |
| **Polished** (mobile, design, UX refinement) | 3-4 months | Production-quality product |

---

## Comparison Summary

| Approach | Setup Time | Cost | Polarsteps Match | Maintenance |
|----------|-----------|------|------------------|-------------|
| **CM Routes Manager** (single plugin) | 1 hour | $59 | 85% | Low |
| **Free plugin combo** | 2 hours | Free | 40-50% | Low |
| **Fotorama-Leaflet-Elevation** | 1 hour | Free | 75% | Low |
| **Embed Polarsteps** | 15 min | Free | 70% (external) | None |
| **AdventureLog** (separate app) | 4-8 hours | Hosting only | 80% | Medium |
| **Custom plugin** | 40-80 hours | Free (Leaflet) | 95% | High |

---

## Recommended Path for simonswanderlust

### Quick Win (Today)

1. Install **[Travelers' Map](https://wordpress.org/plugins/travelers-map/)** (free) -- instantly maps all your blog posts
2. Install **[WP GPX Maps](https://wordpress.org/plugins/wp-gpx-maps/)** (free) -- add route maps to travel posts
3. Install **[Interactive Geo Maps](https://wordpress.org/plugins/interactive-geo-maps/)** (free) -- "visited countries" on your about page

### Better Experience (This Week)

4. Try **[Fotorama-Leaflet-Elevation](https://github.com/MartinvonBerg/Fotorama-Leaflet-Elevation)** for the photo-map sync experience
5. Or buy **[CM Routes Manager](https://www.cminds.com/wordpress-plugins-library/google-maps-routes-manager-plugin-for-wordpress-by-creativeminds/)** ($59) for the most complete single-plugin solution

### Full Polarsteps Experience (Long Term)

6. Evaluate **[AdventureLog](https://github.com/seanmorley15/AdventureLog)** on a Docker instance
7. Or invest in a **custom WordPress plugin** using Leaflet.js + leaflet-gpx + timeline UI

### What No WordPress Solution Can Do

- **Automatic GPS tracking** -- requires a native mobile app, not possible in web-only
- **Real-time offline sync** -- browser limitations
- **Polarsteps-quality mobile UX** -- their app is purpose-built for mobile

---

## All Sources

### WordPress Plugins
- [WP GPX Maps](https://wordpress.org/plugins/wp-gpx-maps/) | [GitHub](https://github.com/devfarm-it/wp-gpx-maps)
- [Travelers' Map](https://wordpress.org/plugins/travelers-map/) | [GitHub](https://github.com/Socrapop/travelers-map)
- [Interactive Geo Maps](https://wordpress.org/plugins/interactive-geo-maps/) | [interactivegeomaps.com](https://interactivegeomaps.com/)
- [TravelMap](https://wordpress.org/plugins/travelmap-blog/) | [travelmap.net](https://travelmap.net)
- [MapPress](https://wordpress.org/plugins/mappress-google-maps-for-wordpress/) | [mappresspro.com](https://mappresspro.com/)
- [Maps Marker Pro](https://www.mapsmarker.com/)
- [CM Routes Manager](https://www.cminds.com/wordpress-plugins-library/google-maps-routes-manager-plugin-for-wordpress-by-creativeminds/)
- [MapSVG](https://mapsvg.com/)
- [Nomad World Map](https://wordpress.org/plugins/nomad-world-map/)
- [Open User Map](https://www.open-user-map.com/)
- [Leaflet Map](https://wordpress.org/plugins/leaflet-map/)
- [Fotorama-Leaflet-Elevation](https://github.com/MartinvonBerg/Fotorama-Leaflet-Elevation)

### Polarsteps Integration
- [Polarsteps Embed Support](https://support.polarsteps.com/article/171-can-i-embed-my-polarsteps-trip-on-my-website)
- [Polarsteps Integration (jan-muller)](https://github.com/jan-muller/polarsteps-integration)
- [Integrate Polarsteps (npersonn)](https://github.com/npersonn/integrate-polarsteps)
- [Polarsteps API (unofficial Python)](https://github.com/remuzel/polarsteps-api)
- [Polarsteps Data Parser](https://github.com/niekvleeuwen/polarsteps-data-parser)

### JavaScript Libraries
- [Leaflet.js](https://leafletjs.com/)
- [leaflet-gpx](https://github.com/mpetazzoni/leaflet-gpx)
- [Leaflet.Polyline.SnakeAnim](https://github.com/IvanSanchez/Leaflet.Polyline.SnakeAnim)
- [leaflet-ant-path](https://github.com/rubenspgcavalcante/leaflet-ant-path)
- [leaflet-providers](https://github.com/leaflet-extras/leaflet-providers)
- [MapLibre GL JS](https://maplibre.org/)
- [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/)
- [gpxparser](https://www.npmjs.com/package/gpxparser)
- [gpxjs](https://github.com/We-Gold/gpxjs)
- [exifr](https://github.com/MikeKovarik/exifr)
- [Swiper.js](https://swiperjs.com/)

### Open-Source Alternatives
- [AdventureLog](https://github.com/seanmorley15/AdventureLog) | [adventurelog.app](https://adventurelog.app/)
- [Trip (itskovacs)](https://github.com/itskovacs/trip)

### General References
- [WordPress REST API Handbook](https://developer.wordpress.org/rest-api/)
- [WordPress Block Editor Handbook](https://developer.wordpress.org/block-editor/)
- [Mapbox x Polarsteps Showcase](https://www.mapbox.com/showcase/polarsteps)
- [Best Travel Map Plugins 2026](https://physcode.com/best-travel-map-plugin-for-wordpress/)
