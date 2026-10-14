#!/usr/bin/env python3
"""Rough Monte Carlo for main-line clear rate (normal package, eat/drink at tier>=1)."""
import json
import random
import math
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

WEATHERS = [
    ("clear", 1.0, 0),
    ("cloud", 1.05, 1),
    ("fog", 1.25, 4),
    ("rain", 1.35, 6),
    ("heavy_rain", 1.55, 10),
    ("snow", 1.4, 7),
    ("blizzard", 1.85, 14),
    ("whiteout", 1.7, 12),
    ("gale", 1.45, 9),
    ("storm", 1.75, 16),
]


@dataclass
class NeedsParams:
    food_hours_move: float = 5.0
    water_hours_move: float = 4.0
    food_hours_rest: float = 7.0
    water_hours_rest: float = 6.0
    hunger_base: tuple = (0, 1, 3, 7)
    hunger_floor_mul: float = 2.5
    thirst_base: tuple = (0, 2, 5)
    thirst_floor_mul: float = 3.0
    passive_ft: float = 1.35
    passive_wt: float = 1.65
    passive_fn: float = 1.5
    passive_wn: float = 1.7
    passive_scale_rest: float = 0.35
    spike_food_move: int = 12
    spike_water_move: int = 16
    spike_food_rest: int = 7
    spike_water_rest: int = 9
    loss_cap_base_move: int = 16
    loss_cap_base_rest: int = 10
    loss_cap_per_hour: float = 4.5
    camp_pen_food: tuple = (0, 2, 6, 12)
    camp_pen_water: tuple = (0, 3, 8)


def weather_pick(risk):
    r = random.random() * 10 + risk
    order = [
        (13, 6), (11.5, 8), (10, 7), (8.5, 4), (7.2, 9), (6, 5),
        (4.8, 2), (3.5, 3), (2, 1),
    ]
    for thresh, idx in order:
        if r > thresh:
            return WEATHERS[idx]
    return WEATHERS[0]


def food_tier(n):
    if n < 0.22:
        return 0
    if n < 0.48:
        return 1
    if n < 0.78:
        return 2
    return 3


def water_tier(n):
    if n < 0.25:
        return 0
    if n < 0.58:
        return 1
    return 2


def hunger_move_extra(fn, p: NeedsParams):
    t = food_tier(fn)
    return p.hunger_base[t] + math.floor(fn * p.hunger_floor_mul)


def thirst_move_extra(wn, p: NeedsParams):
    t = water_tier(wn)
    return p.thirst_base[t] + math.floor(wn * p.thirst_floor_mul)


def needs_hours_mult(fn, wn):
    m = 1.0
    if food_tier(fn) >= 2:
        m += 0.03 + max(0, fn - 0.48) * 0.07
    if water_tier(wn) >= 2:
        m += 0.035 + max(0, wn - 0.58) * 0.08
    return min(1.2, m)


def tick_needs(state, hours, resting, p: NeedsParams):
    fn, wn, stam = state["foodNeed"], state["waterNeed"], state["stam"]
    stam_at = stam
    cap = round((p.loss_cap_base_rest if resting else p.loss_cap_base_move) + hours * p.loss_cap_per_hour)
    fn += hours / (p.food_hours_rest if resting else p.food_hours_move)
    wn += hours / (p.water_hours_rest if resting else p.water_hours_move)
    ft, wt = food_tier(fn), water_tier(wn)
    if ft or wt:
        scale = p.passive_scale_rest if resting else 1.0
        stam -= round(scale * hours * (ft * p.passive_ft + wt * p.passive_wt + fn * p.passive_fn + wn * p.passive_wn))
    while fn >= 1:
        fn -= 1
        stam -= p.spike_food_rest if resting else p.spike_food_move
    while wn >= 1:
        wn -= 1
        stam -= p.spike_water_rest if resting else p.spike_water_move
    lost = stam_at - stam
    if lost > cap:
        stam = stam_at - cap
    state["foodNeed"], state["waterNeed"], state["stam"] = fn, wn, max(0, stam)


def maybe_consume(state):
    fn, wn = state["foodNeed"], state["waterNeed"]
    if food_tier(fn) >= 1 and state["food"] > 0:
        state["food"] -= 1
        fn = max(0, fn - 1)
        state["stam"] = min(100, state["stam"] + 16)
    if water_tier(wn) >= 1 and state["water"] > 0:
        state["water"] -= 1
        wn = max(0, wn - 1)
        state["stam"] = min(100, state["stam"] + 10)
    state["foodNeed"], state["waterNeed"] = fn, wn


def altitude_stam_extra(alt_level):
    if not alt_level:
        return 0
    return max(0, alt_level * 3 + (2 if alt_level >= 2 else 0) - 5)


def altitude_move_mult(alt_level):
    if not alt_level:
        return 1.0
    return 1 + alt_level * 0.06 + (0.08 if alt_level >= 3 else 0)


def update_altitude(state, from_alt, to_alt, hours):
    cfg_onset, cfg_severe = 3300, 3500
    alt = max(from_alt, to_alt)
    gain = 0.0
    if alt >= cfg_onset:
        gain += hours * (0.8 + (alt - cfg_onset) / 800)
        if alt >= cfg_severe:
            gain += hours * 0.45
    climb = to_alt - from_alt
    if climb > 350:
        gain += 10 + (climb - 350) / 40
    if gain > 0:
        state["altExposure"] += gain * 0.65
    if to_alt < 3000:
        state["altExposure"] = max(0, state["altExposure"] - 14)
    elif to_alt < cfg_onset:
        state["altExposure"] = max(0, state["altExposure"] - 8)
    exp = state["altExposure"]
    if exp < 18:
        state["altLevel"] = 0
    elif exp < 42:
        state["altLevel"] = 1
    elif exp < 72:
        state["altLevel"] = 2
    else:
        state["altLevel"] = 3


def camp_need_pen(fn, wn, p: NeedsParams):
    return p.camp_pen_food[food_tier(fn)] + p.camp_pen_water[water_tier(wn)]


def run_once(points, p: NeedsParams, n_camps_max=12):
    if random.random() < 15 / 60:
        return "turnback"
    if random.random() > 0.92:
        return "turnback"

    state = {
        "stam": 100,
        "food": 11,
        "water": 13,
        "foodNeed": 0.0,
        "waterNeed": 0.0,
        "altExposure": 0.0,
        "altLevel": 0,
        "hypo": 0,
    }
    camps_used = 0
    hours_since_camp = 0.0

    for i in range(len(points) - 1):
        from_p, to_p = points[i], points[i + 1]
        should_camp = (
            camps_used < n_camps_max
            and (state["stam"] < 58 or hours_since_camp >= 14 or food_tier(state["foodNeed"]) >= 2)
        )
        if should_camp:
            np = camp_need_pen(state["foodNeed"], state["waterNeed"], p)
            bonus = 28 + 14 - np - state["hypo"] * 5
            tick_needs(state, 8, True, p)
            state["stam"] = min(100, state["stam"] + max(0, bonus))
            camps_used += 1
            hours_since_camp = 0.0
            if state["stam"] <= 0:
                return "stamina"
            maybe_consume(state)

        if from_p.get("water") and state["water"] < 5:
            state["water"] = min(10, state["water"] + 3)

        maybe_consume(state)

        risk = max(from_p.get("weather_risk", 1), to_p.get("weather_risk", 1))
        wid, wmult, wstam = weather_pick(risk)
        stam_r, mult_r = (6, 0.12) if wid in ("rain", "heavy_rain", "storm") else (0, 0)
        if wid in ("blizzard", "snow"):
            stam_r, mult_r = 5, 0.08
        hours = to_p.get("hours_base", 1) * wmult * (1 - mult_r) * altitude_move_mult(state["altLevel"])
        hours *= needs_hours_mult(state["foodNeed"], state["waterNeed"])

        stam_cost = round(
            8 + to_p.get("weather_risk", 1) * 2 + wstam
            + hunger_move_extra(state["foodNeed"], p)
            + thirst_move_extra(state["waterNeed"], p)
            + (2 if state["food"] < 1 else 0)
            + 2
            + altitude_stam_extra(state["altLevel"])
            - stam_r
        )
        state["stam"] = max(0, state["stam"] - max(3, stam_cost))
        tick_needs(state, hours, False, p)
        hours_since_camp += hours
        update_altitude(state, from_p.get("alt_m", 0), to_p.get("alt_m", 0), hours)

        if risk >= 3 and random.random() < 0.05:
            state["stam"] -= max(4, 10 - stam_r)

        if state["stam"] <= 0:
            return "stamina"
        if state["altLevel"] >= 3 and state["altExposure"] > 96 and random.random() < 0.12:
            return "altitude"

    return "clear"


def simulate(label, p: NeedsParams, n=8000):
    points = json.loads((ROOT / "points.json").read_text())
    counts = {}
    for _ in range(n):
        r = run_once(points, p)
        counts[r] = counts.get(r, 0) + 1
    clear = counts.get("clear", 0) / n
    print(f"\n=== {label} (n={n}) ===")
    for k in sorted(counts, key=lambda x: -counts[x]):
        print(f"  {k}: {counts[k]/n*100:.1f}%")
    print(f"  -> main clear ~{clear*100:.1f}%")


if __name__ == "__main__":
    p = NeedsParams()
    random.seed(42)
    simulate("CURRENT (post-balance params)", p, 8000)
