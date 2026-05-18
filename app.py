from flask import Flask, request, jsonify, render_template
import requests, os
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
ORS_API_KEY = os.environ.get('ORS_API_KEY')

@app.route('/')
def index():
    return render_template('index.html')

# ── Geocode ────────────────────────────────────────────────────
def geocode(place):
    parts = place.split(',')
    if len(parts) == 2:
        try:
            lat = float(parts[0].strip())
            lng = float(parts[1].strip())
            return [lng, lat]
        except ValueError:
            pass
    url    = "https://api.openrouteservice.org/geocode/search"
    params = {"api_key": ORS_API_KEY, "text": place, "size": 1}
    r      = requests.get(url, params=params)
    feats  = r.json().get('features', [])
    if not feats:
        return None
    return feats[0]['geometry']['coordinates']

# ── Autocomplete ───────────────────────────────────────────────
@app.route('/autocomplete')
def autocomplete():
    q = request.args.get('q', '')
    if len(q) < 3:
        return jsonify([])
    url    = "https://api.openrouteservice.org/geocode/autocomplete"
    params = {"api_key": ORS_API_KEY, "text": q, "size": 6}
    r      = requests.get(url, params=params)
    feats  = r.json().get('features', [])
    return jsonify([{
        "label": f['properties'].get('label', ''),
        "lat":   f['geometry']['coordinates'][1],
        "lng":   f['geometry']['coordinates'][0]
    } for f in feats])

# ── ORS maneuver type → haptic command code ────────────────────
# Two-stage system: each turn returns a (warn_cmd, confirm_cmd) pair
# warn_cmd  fires at alert_dist metres  → lower intensity "prepare"
# confirm_cmd fires at 80m             → full intensity "now"
def ors_to_cmds(step_type, exit_number=1):
    t = step_type
    # (warn_cmd, confirm_cmd, alert_dist_metres)
    mapping = {
        0:  (0x53, 0x21, 250),   # sharp left
        1:  (0x54, 0x22, 250),   # sharp right
        2:  (0x53, 0x21, 250),   # sharp left (duplicate in ORS)
        3:  (0x54, 0x22, 250),   # sharp right
        4:  (0x51, 0x01, 150),   # slight left
        5:  (0x52, 0x02, 150),   # slight right
        6:  None,                # straight — skip
        7:  (0x56, 0x40 + min(exit_number, 4), 300),  # roundabout
        8:  (0x55, 0x30, 300),   # U-turn
        9:  (0x51, 0x11, 200),   # left
        10: (None, 0xA0, 80),    # arrive — no warning
        11: None,                # depart — skip
        12: (0x52, 0x12, 200),   # right
        13: (0x56, 0x32, 500),   # highway exit right
        14: (0x56, 0x31, 500),   # highway exit left
    }
    return mapping.get(t)

# ── Route ──────────────────────────────────────────────────────
@app.route('/route', methods=['POST'])
def get_route():
    data        = request.json
    origin      = data.get('origin')
    destination = data.get('destination')

    orig_coords = geocode(origin)
    dest_coords = geocode(destination)
    if not orig_coords or not dest_coords:
        return jsonify({"error": "Could not geocode one or both locations"}), 400

    url     = "https://api.openrouteservice.org/v2/directions/driving-car"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body    = {
        "coordinates": [orig_coords, dest_coords],
        "instructions": True,
        "geometry":     True
    }
    resp = requests.post(url, json=body, headers=headers)
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), 400

    import polyline
    route    = resp.json()['routes'][0]
    summary  = route['summary']
    coords   = polyline.decode(route['geometry'])
    path     = [{"lat": c[0], "lng": c[1]} for c in coords]

    steps_all = []
    for seg in route['segments']:
        steps_all.extend(seg['steps'])

    waypoints = []
    for step in steps_all:
        t          = step.get('type', -1)
        exit_num   = step.get('exit_number', 1)
        cmds       = ors_to_cmds(t, exit_num)
        if cmds is None:
            continue

        end_idx = step.get('way_points', [0])[-1]
        if end_idx >= len(coords):
            continue
        end = coords[end_idx]

        warn_cmd, confirm_cmd, alert_dist = cmds
        instr = step.get('instruction', '')

        # Direction label for UI
        if t in (0,2,4,9):      direction = 'L'
        elif t in (1,3,5,12):   direction = 'R'
        elif t == 8:             direction = 'U'
        elif t == 7:             direction = 'RB'
        elif t in (13,14):      direction = 'HW'
        elif t == 10:            direction = 'A'
        else:                    direction = 'S'

        waypoints.append({
            "lat":        end[0],
            "lng":        end[1],
            "direction":  direction,
            "warn_cmd":   warn_cmd,
            "confirm_cmd":confirm_cmd,
            "alert_dist": alert_dist,
            "instruction":instr,
            "distance":   str(round(step['distance'])) + ' m'
        })

    return jsonify({
        "waypoints":    waypoints,
        "path":         path,
        "total_dist":   f"{round(summary['distance']/1000,1)} km",
        "total_time":   f"{round(summary['duration']/60)} mins",
        "start_addr":   origin,
        "end_addr":     destination,
        "start_latlng": {"lat": orig_coords[1], "lng": orig_coords[0]},
        "end_latlng":   {"lat": dest_coords[1], "lng": dest_coords[0]}
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))