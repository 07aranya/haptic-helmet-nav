from flask import Flask, request, jsonify, render_template
import requests
from dotenv import load_dotenv
import os
load_dotenv()

app = Flask(__name__)

ORS_API_KEY = os.environ.get('ORS_API_KEY') 

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/route', methods=['POST'])
def get_route():
    data        = request.json
    origin      = data.get('origin')
    destination = data.get('destination')

    # ── Step 1: Geocode origin and destination to lat/lng ──────
    def geocode(place):
        url = "https://api.openrouteservice.org/geocode/search"
        params = {
            "api_key": ORS_API_KEY,
            "text":    place,
            "size":    1
        }
        r = requests.get(url, params=params)
        features = r.json().get('features', [])
        if not features:
            return None
        coords = features[0]['geometry']['coordinates']
        return coords   # [lng, lat]

    orig_coords = geocode(origin)
    dest_coords = geocode(destination)

    if not orig_coords or not dest_coords:
        return jsonify({"error": "Could not geocode one or both locations"}), 400

    # ── Step 2: Get driving directions ────────────────────────
    url = "https://api.openrouteservice.org/v2/directions/driving-car"
    headers = {
        "Authorization": ORS_API_KEY,
        "Content-Type":  "application/json"
    }
    body = {
        "coordinates": [orig_coords, dest_coords],
        "instructions": True,
        "geometry":     True
    }

    resp = requests.post(url, json=body, headers=headers)
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), 400

    route_data = resp.json()
    route      = route_data['routes'][0]
    summary    = route['summary']
    segments   = route['segments']
    steps_all  = []
    for seg in segments:
        steps_all.extend(seg['steps'])

    # ── Step 3: Decode geometry (encoded polyline) ─────────────
    import polyline
    coords     = polyline.decode(route['geometry'])
    path_coords = [{"lat": c[0], "lng": c[1]} for c in coords]

    # ── Step 4: Extract waypoints from steps ───────────────────
    # ORS instruction types:
    # 0=left, 1=right, 2=sharp left, 3=sharp right,
    # 4=slight left, 5=slight right, 6=straight,
    # 7=enter roundabout, 10=arrive
    LEFT_TYPES    = {0, 2, 4}
    RIGHT_TYPES   = {1, 3, 5}
    ARRIVE_TYPES  = {10}
    SKIP_TYPES    = {6, 7, 8, 9, 11}   # straight/roundabout/depart

    waypoints = []
    for step in steps_all:
        t        = step.get('type', -1)
        way_pts  = step.get('way_points', [0])
        end_idx  = way_pts[-1]

        if end_idx >= len(coords):
            continue

        end_coord = coords[end_idx]

        if t in LEFT_TYPES:
            direction = 'L'
        elif t in RIGHT_TYPES:
            direction = 'R'
        elif t in ARRIVE_TYPES:
            direction = 'A'
        elif t in SKIP_TYPES:
            continue
        else:
            continue

        waypoints.append({
            "lat":         end_coord[0],
            "lng":         end_coord[1],
            "direction":   direction,
            "instruction": step.get('instruction', ''),
            "distance":    str(round(step['distance'])) + ' m'
        })

    # Ensure arrival is always last
    if not waypoints or waypoints[-1]['direction'] != 'A':
        last = coords[-1]
        waypoints.append({
            "lat":         last[0],
            "lng":         last[1],
            "direction":   'A',
            "instruction": 'Arrive at destination',
            "distance":    ''
        })

    dist_km = round(summary['distance'] / 1000, 1)
    dur_min = round(summary['duration'] / 60)

    return jsonify({
        "waypoints":   waypoints,
        "path":        path_coords,
        "total_dist":  f"{dist_km} km",
        "total_time":  f"{dur_min} mins",
        "start_addr":  origin,
        "end_addr":    destination
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))