"""Hangzhou weather: watch the forecast on a schedule, hand only unusual weather to the next turn.

Nothing here sends a message. An unusual forecast becomes one scene event, and the chat decides whether to
bring it up and how to word it, so a normal sunny day stays silent.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated

import httpx
from pydantic import BaseModel, ConfigDict, Field
from zoneinfo import ZoneInfo

from len_bot.plugin import Invocation, Plugin, PluginContext, tool

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ZONE = ZoneInfo("Asia/Shanghai")
WATCH_SECONDS = 60
FIRST_CHECK_SECONDS = 90
DUE_GRACE_MINUTES = 10
MAX_SLOT_ATTEMPTS = 3
FORECAST_DAYS = 2
REQUEST_TIMEOUT = 15.0
KEEP_SLOTS = 12

CONDITIONS = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "有雾", 48: "有雾凇",
    51: "有小毛毛雨", 53: "有毛毛雨", 55: "有大毛毛雨", 56: "有冻毛毛雨", 57: "有强冻毛毛雨",
    61: "有小雨", 63: "有中雨", 65: "有大雨", 66: "有冻雨", 67: "有强冻雨",
    71: "有小雪", 73: "有中雪", 75: "有大雪", 77: "有米雪",
    80: "有小阵雨", 81: "有阵雨", 82: "有强阵雨", 85: "有小阵雪", 86: "有强阵雪",
    95: "有雷阵雨", 96: "有雷阵雨伴冰雹", 99: "有强雷暴伴冰雹",
}
WET_CODES = frozenset({51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
                       71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99})
# How the same sky sounds when someone talks about it instead of reading a report.
SPOKEN = {
    0: "晴", 1: "晴", 2: "多云", 3: "阴", 45: "有雾", 48: "有雾凇",
    51: "毛毛雨", 53: "毛毛雨", 55: "大毛毛雨", 56: "冻毛毛雨", 57: "强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨", 99: "强雷暴",
}
SNOW = frozenset({71, 73, 75, 77, 85, 86})
FOG = frozenset({45, 48})


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    days: int = Field(default=1, ge=1, le=3, description="要看几天，1 表示今天，2 表示今天和明天")


def _number(value: object, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


class Weather(Plugin):
    def __init__(self, ctx: PluginContext) -> None:
        super().__init__(ctx)
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True)
        self.ctx.start_task("天气巡检", self._watch())
        self.ctx.start_task("天气首查", self._first_check())

    async def _first_check(self) -> None:
        """Look once shortly after start so a restart shows the pipeline works without waiting for the slot."""
        await asyncio.sleep(FIRST_CHECK_SECONDS)
        try:
            await self._check(datetime.now(ZONE))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - the first look is a bonus, never fatal
            self.ctx.log.warning("天气首查失败：%s", error)

    async def stop(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            await client.aclose()

    # ---- 配置 ----

    @property
    def place(self) -> str:
        value = self.ctx.config.get("place")
        return value.strip() if isinstance(value, str) and value.strip() else "杭州"

    @property
    def latitude(self) -> float:
        return _number(self.ctx.config.get("latitude"), 30.2741)

    @property
    def longitude(self) -> float:
        return _number(self.ctx.config.get("longitude"), 120.1551)

    @property
    def check_times(self) -> list[tuple[int, int]]:
        value = self.ctx.config.get("check_times")
        if not isinstance(value, str):
            return []
        result = []
        for item in value.split(","):
            piece = item.strip()
            if not piece or ":" not in piece:
                continue
            hour, _, minute = piece.partition(":")
            try:
                h, m = int(hour), int(minute)
            except ValueError:
                continue
            if 0 <= h <= 23 and 0 <= m <= 59:
                result.append((h, m))
        return result

    @property
    def limits(self) -> dict[str, float]:
        return {
            "max_temp": _number(self.ctx.config.get("max_temp"), 35.0),
            "min_temp": _number(self.ctx.config.get("min_temp"), 0.0),
            "rain": _number(self.ctx.config.get("rain_probability"), 60.0),
            "wind": _number(self.ctx.config.get("wind_speed"), 10.8),
            "swing": _number(self.ctx.config.get("temp_swing"), 10.0),
        }

    # ---- 数据 ----

    async def _forecast(self) -> dict:
        client = self._client
        if client is None:
            raise RuntimeError("天气插件尚未启动")
        response = await client.get(FORECAST_URL, params={
            "latitude": self.latitude,
            "longitude": self.longitude,
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                     "precipitation_probability_max,wind_speed_10m_max",
            "hourly": "weather_code,precipitation_probability",
            "wind_speed_unit": "ms",
            "timezone": "Asia/Shanghai",
            "forecast_days": FORECAST_DAYS,
        })
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("daily"), dict):
            raise ValueError("天气接口没有返回 daily 数据")
        return payload

    @staticmethod
    def _series(daily: dict, key: str) -> list:
        value = daily.get(key)
        return value if isinstance(value, list) else []

    def _issues(self, payload: dict) -> list[tuple[str, str]]:
        """Unusual weather worth mentioning, as (kind, fact) pairs; a normal day returns nothing."""
        daily = payload["daily"]
        codes = self._series(daily, "weather_code")
        highs = self._series(daily, "temperature_2m_max")
        lows = self._series(daily, "temperature_2m_min")
        probs = self._series(daily, "precipitation_probability_max")
        winds = self._series(daily, "wind_speed_10m_max")
        limit = self.limits
        found: list[tuple[str, str]] = []

        code = codes[0] if codes else None
        probability = probs[0] if probs else None
        wet = code in WET_CODES if isinstance(code, int) else False
        if wet or (isinstance(probability, (int, float)) and probability >= limit["rain"]):
            if isinstance(code, int) and code in SNOW:
                phrase = f"外面在下{SPOKEN.get(code, '雪')}"
            elif isinstance(code, int) and code in FOG:
                phrase = "外面有雾，湿气重"
            elif isinstance(code, int) and code in WET_CODES:
                phrase = f"外面在下{SPOKEN.get(code, '雨')}"
            else:
                phrase = "外面阴着，像是要下雨"
            found.append(("rain", phrase))

        high = highs[0] if highs else None
        if isinstance(high, (int, float)) and high >= limit["max_temp"]:
            found.append(("heat", f"今天最高会到 {high:.0f}℃，热得慌"))

        low = lows[0] if lows else None
        if isinstance(low, (int, float)) and low <= limit["min_temp"]:
            found.append(("cold", f"今天最低 {low:.0f}℃，冷得厉害"))

        wind = winds[0] if winds else None
        if isinstance(wind, (int, float)) and wind >= limit["wind"]:
            found.append(("wind", "外面风挺大"))

        if len(highs) > 1 and isinstance(highs[0], (int, float)) and isinstance(highs[1], (int, float)):
            difference = highs[1] - highs[0]
            if abs(difference) >= limit["swing"]:
                turn = "冷" if difference < 0 else "热"
                found.append(("swing", f"明天比今天{turn} {abs(difference):.0f}℃"))
        return found

    def _compose(self, payload: dict, issues: list[tuple[str, str]]) -> str:
        """One sentence about the weather outside: no place name, no date, no percentages."""
        daily = payload["daily"]
        highs = self._series(daily, "temperature_2m_max")
        lows = self._series(daily, "temperature_2m_min")
        facts = "，".join(text for _, text in issues)
        span = ""
        # 已经说了最高或最低温，就不再补一遍区间。
        if not {kind for kind, _ in issues} & {"heat", "cold"} \
                and highs and lows and isinstance(highs[0], (int, float)) and isinstance(lows[0], (int, float)):
            span = f"，{lows[0]:.0f}~{highs[0]:.0f}℃"
        return f"{facts}{span}。"

    # ---- 巡检 ----

    def _due_slot(self, now: datetime) -> str | None:
        """The planned check that just came due, so a restart inside the window does not skip it."""
        for hour, minute in self.check_times:
            planned = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if 0 <= (now - planned).total_seconds() < DUE_GRACE_MINUTES * 60:
                return f"{now.date().isoformat()} {hour:02d}:{minute:02d}"
        return None

    async def _watch(self) -> None:
        checked = [item for item in await self.ctx.get_kv("checked", []) if isinstance(item, str)]
        retry_slot, attempts = None, 0
        while True:
            try:
                now = datetime.now(ZONE)
                slot = self._due_slot(now)
                if slot != retry_slot:
                    retry_slot, attempts = slot, 0
                if slot is not None and slot not in checked and attempts < MAX_SLOT_ATTEMPTS:
                    attempts += 1
                    await self._check(now)
                    updated = (checked + [slot])[-KEEP_SLOTS:]
                    await self.ctx.set_kv("checked", updated)
                    checked = updated
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - a failed check must not stop the loop
                self.ctx.log.warning("天气检查失败：%s", error)
            await asyncio.sleep(WATCH_SECONDS)

    async def _check(self, now: datetime) -> None:
        payload = await self._forecast()
        issues = self._issues(payload)
        if not issues:
            return
        today = now.date().isoformat()
        sent = await self.ctx.get_kv("sent", {})
        done = sent.get(today) if isinstance(sent, dict) else None
        done = [item for item in done if isinstance(item, str)] if isinstance(done, list) else []
        fresh = [(kind, text) for kind, text in issues if kind not in done]
        if not fresh:
            return
        text = self._compose(payload, fresh)
        for scene in self.ctx.scenes:
            await self.ctx.emit_event(scene, text)
        await self.ctx.set_kv("sent", {today: done + [kind for kind, _ in fresh]})
        self.ctx.log.info("天气异常已交给对话：%s", text)

    # ---- 工具 ----

    @tool("weather", "查询杭州的天气预报，返回每天的天况、最高最低温、降水概率和最大风速。"
                     "有人问今天或明天天气、要不要带伞、穿什么、会不会下雨时调用。",
          summary="查询杭州天气")
    async def weather_now(self, ctx: Invocation,
                          request: Annotated[ForecastRequest, Field(description="要看几天的预报")]) -> dict:
        payload = await self._forecast()
        daily = payload["daily"]
        codes = self._series(daily, "weather_code")
        highs = self._series(daily, "temperature_2m_max")
        lows = self._series(daily, "temperature_2m_min")
        probs = self._series(daily, "precipitation_probability_max")
        winds = self._series(daily, "wind_speed_10m_max")
        dates = self._series(daily, "time")
        days = []
        for index in range(min(request.days, len(dates))):
            code = codes[index] if index < len(codes) else None
            days.append({
                "date": dates[index],
                "weather": CONDITIONS.get(code, "未知") if isinstance(code, int) else "未知",
                "high_celsius": highs[index] if index < len(highs) else None,
                "low_celsius": lows[index] if index < len(lows) else None,
                "rain_probability": probs[index] if index < len(probs) else None,
                "wind_speed_ms": winds[index] if index < len(winds) else None,
            })
        return {"place": self.place, "timezone": "Asia/Shanghai", "days": days,
                "notable": [text for _, text in self._issues(payload)]}
