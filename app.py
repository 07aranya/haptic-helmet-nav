from flask import Flask, request, jsonify, render_template
import requests, os
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
ORS_API_KEY = os.environ.get('ORS_API_KEY')

@app.route('/')
def index():
    return render_template('index.html')

def geocode(place):
    parts = place.split(',')
    if len(parts) == 2:
        try:
            lat = float(parts[0].strip())
            lng = float(parts[1].strip())
            return [lng, lat]
        except ValueError:
            pass
    url = "https://api.openrouteservice.org/geocode/search"
    params = {"api_key": ORS_API_KEY, "text": place, "size": 1}
    r = requests.get(url, params=params)
    features = r.json().get('features', [])
    if not features:
        return None
    return features[0]['geometry']['coordinates']

@app.route('/autocomplete')
def autocomplete():
    q = request.args.get('q', '')
    if len(q) < 3:
        return jsonify([])
    url = "https://api.openrouteservice.org/geocode/autocomplete"
    params = {"api_key": ORS_API_KEY, "text": q, "size": 6}
    r = requests.get(url, params=params)
    features = r.json().get('features', [])
    return jsonify([{
        "label": f['properties'].get('label', ''),
        "lat":   f['geometry']['coordinates'][1],
        "lng":   f['geometry']['coordinates'][0]
    } for f in features])

@app.route('/route', methods=['POST'])
def get_route():
    data        = request.json
    origin      = data.get('origin')
    destination = data.get('destination')

    orig_coords = geocode(origin)
    dest_coords = geocode(destination)
    if not orig_coords or not dest_coords:
        return jsonify({"error": "Could not geocode one or both locations"}), 400

    url = "https://api.openrouteservice.org/v2/directions/driving-car"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {"coordinates": [orig_coords, dest_coords], "instructions": True, "geometry": True}
    resp = requests.post(url, json=body, headers=headers)
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), 400

    route    = resp.json()['routes'][0]
    summary  = route['summary']
    steps_all = []
    for seg in route['segments']:
        steps_all.extend(seg['steps'])

    import polyline
    coords      = polyline.decode(route['geometry'])
    path_coords = [{"lat": c[0], "lng": c[1]} for c in coords]

    LEFT_TYPES   = {0, 2, 4}
    RIGHT_TYPES  = {1, 3, 5}
    ARRIVE_TYPES = {10}
    SKIP_TYPES   = {6, 7, 8, 9, 11}

    waypoints = []
    for step in steps_all:
        t       = step.get('type', -1)
        end_idx = step.get('way_points', [0])[-1]
        if end_idx >= len(coords): continue
        end     = coords[end_idx]
        if t in LEFT_TYPES:    d = 'L'
        elif t in RIGHT_TYPES: d = 'R'
        elif t in ARRIVE_TYPES: d = 'A'
        elif t in SKIP_TYPES:  continue
        else: continue
        waypoints.append({
            "lat": end[0], "lng": end[1], "direction": d,
            "instruction": step.get('instruction', ''),
            "distance": str(round(step['distance'])) + ' m'
        })

    if not waypoints or waypoints[-1]['direction'] != 'A':
        last = coords[-1]
        waypoints.append({"lat": last[0], "lng": last[1],
                          "direction": "A", "instruction": "Arrive at destination", "distance": ""})

    return jsonify({
        "waypoints":  waypoints,
        "path":       path_coords,
        "total_dist": f"{round(summary['distance']/1000, 1)} km",
        "total_time": f"{round(summary['duration']/60)} mins",
        "start_addr": origin,
        "end_addr":   destination,
        "start_latlng": {"lat": orig_coords[1], "lng": orig_coords[0]},
        "end_latlng":   {"lat": dest_coords[1], "lng": dest_coords[0]}
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))