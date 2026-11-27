"""被点名要求说嗨嗨、或要生日祝福时发一段语音。

触发靠 ``@regex``。本地宿主在接管前检查实际 @ 段和插件设置；
没点名而需要点名的群消息仍走正常唤醒判断。处理器保留同样的防御性检查。
"""

import asyncio
import datetime
from pathlib import Path

from len_bot.plugin import Audio, Invocation, Plugin, PluginContext, Text, regex

# 关键词：必须带「说/索/来/整…」这类动词，或者「嗨嗨嗨」叠词，才认定是在点她
# 裸「嗨嗨」不匹配——那是打招呼，不能把这条消息从模型手里拿走
PATTERN = (
    r"[^\n]{0,24}(?:说|索|嗦|苏|塞|晒|来|整|喊|唱|搞|给|送)[^\n]{0,6}嗨嗨[^\n]{0,12}"
    r"|[^\n]{0,16}嗨嗨嗨[^\n]{0,12}"
    r"|[^\n]{0,24}(?:生日快乐|生日祝福|祝你?生日|过生日)[^\n]{0,12}"
)


class Voice(Plugin):
    def __init__(self, ctx: PluginContext) -> None:
        super().__init__(ctx)
        self._home = Path(__file__).parent
        self._daily_lock = asyncio.Lock()

    # ---------- 工具 ----------

    def _audio(self) -> Path:
        raw = str(self.ctx.config.get("audio_file") or "assets/birthday.aac").strip()
        path = Path(raw)
        return path if path.is_absolute() else self._home / path

    @staticmethod
    def _addressed(message) -> bool:
        """私聊一律算；群里要有 @ 她的 mention 段。"""
        if message.scene.split(":", 2)[1] == "private":
            return True
        me = str(message.bot_id)
        for segment in message.segments:
            if segment.type != "mention":
                continue
            user = str(segment.data.get("user", ""))
            if user == me or user.split(":")[-1] == me.split(":")[-1]:
                return True
        return False

    # ---------- 触发 ----------

    @regex(PATTERN, "被要求说嗨嗨或送生日祝福时发语音")
    async def on_asked(self, ctx: Invocation, match) -> str:
        message = ctx.message
        if message is None:
            return None

        if bool(self.ctx.config.get("require_mention", True)) and message.scene.split(":", 2)[1] != "private":
            if not self._addressed(message):
                return None

        # The KV key is shared by all scenes and senders. Keep its read/send/write
        # sequence together; failed deliveries do not consume the daily allowance.
        async with self._daily_lock:
            uid = message.sender.uid
            today = datetime.date.today().isoformat()
            state = await self.ctx.get_kv("daily", None) or {}
            if state.get("date") != today:
                state = {"date": today, "uids": []}
            used = list(state.get("uids") or [])

            if uid in used:
                reply = str(self.ctx.config.get("repeat_reply") or "已经说过了")
                await self.ctx.send_parts(message.scene, [Text(reply)], reply_to=message.platform_message_id)
                return f"{uid} 今天已经领过，回了「{reply}」"

            audio = self._audio()
            if not audio.is_file():
                return f"语音文件不存在：{audio}"

            sent = await self.ctx.send_parts(
                message.scene, [Audio(str(audio))], reply_to=message.platform_message_id
            )
            if getattr(sent, "status", "") != "sent":
                return f"语音发送未确认：{getattr(sent, 'report', '')}"

            used.append(uid)
            await self.ctx.set_kv("daily", {"date": today, "uids": used})
            return f"给 {uid} 发了语音"
