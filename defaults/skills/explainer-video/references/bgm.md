# 代码合成配乐和音效

用本技能目录下的 `scripts/synth-bgm.mjs`：纯代码合成，不联网、不花钱，同一份参数每次生成的结果一样。配乐响度对齐到 -14 LUFS（和曲库音乐一样），混音时不用另调音量。

1. **时机**：配音做完、`sync-durations` 把真实时长写进 `STORYBOARD.md` 之后。之后时长再变（重配了某句），重新生成一次。
2. **写参数** `audio/bgm-spec.json`：
   ```json
   {
     "mood": "tech",
     "frames": [3.2, 4.1, 5.5, 6, 4.4, 7.2, 5.1, 6.3, 5.8, 4.4],
     "sections": [ {"frame": 1, "energy": 1}, {"frame": 2, "energy": 2}, {"frame": 6, "energy": -1}, {"frame": 6, "offset": 0.8, "energy": 3}, {"frame": 10, "energy": 1} ],
     "hits": [ {"frame": 1, "offset": 0.1, "sfx": "impact"}, {"frame": 6, "offset": 0.8, "sfx": "riser"}, {"frame": 7, "offset": 1.2, "sfx": "ding"} ],
     "end": "ring",
     "seed": 1
   }
   ```
   - `frames`：`STORYBOARD.md` 里每个镜头同步后的时长（秒），按顺序。
   - `mood`：`tech`（科技、AI、工具）、`upbeat`（轻快、干货）、`calm`（舒缓、讲道理）、`tense`（揭秘、翻车、反转）、`playful`（搞笑、吐槽），按脚本【BGM 与音效】和账号风格选。系列里写了配乐风格就照系列。
   - `sections`：能量曲线，时间写 `frame`（第几个镜头，从 1 开始）加 `offset`（镜头内第几秒），也可以写 `at`（全片第几秒）。能量 `0` 只有铺底、`1` 加琶音和低音、`2` 加鼓和旋律、`3` 全开、`-1` 停。常用走法：开头钩子 1，进正文 2，高潮或关键结论 3，结尾 1。最关键的那句话或数字之前停 0.5–1 秒（`-1`）再全开，比一直响更有冲击力。段落起点会自动吸到拍子上，误差不超过半拍。
   - `hits`：音效，只放在画面真有事件的地方，宁少勿多（一般全片 4–8 个）：
     - `impact`/`boom`：开头钩子、反转、砸出大数字
     - `whoosh`：大转场（不是每个切点都加）
     - `riser`：冲进高潮前，和那一段的 `-1→3` 写在同一时刻，会自动在那一刻冲到顶
     - `ding`/`success`：关键数字、结论出现，做成了
     - `pop`：列表项、标签弹出
     - `tick`/`typing`：倒计时、代码和打字画面
     - `glitch`：出错、黑科技
     - `buzz`：答错、误区
     - `shutter`：截图
     - 可以加 `"gain": 0.8` 调轻重。
   - `end`：`ring`（落一个主和弦余音，默认）、`stop`（卡在最后一句急停，适合反转收尾）、`fade`（淡出）。
3. **生成**：在项目目录运行 `node <本技能目录>/scripts/synth-bgm.mjs --spec audio/bgm-spec.json --out-dir assets/audio`。输出的 `assets/audio/bgm.json` 里有节拍网格、各段实际起点和一份 `audio_meta` 条目。
4. **接进成片**：把 `bgm.json` 里 `audio_meta.bgm` 写进项目 `audio_meta.json` 的 `bgm`，`audio_meta.sfx` 并进它的 `sfx`（都带 `"source": "host"`，之后重跑音频步骤也会保留）；`STORYBOARD.md` 顶部 YAML 的 `music:` 改成 `none`，免得再去曲库找。BGM 不写 `volume`，用默认的人声下铺底音量。
5. **检查**：你听不到声音，就看 `bgm.json`：`lufs` 应该是 -14 左右，`hits` 的时间要和对应的画面事件对得上。notes 里记一句「配乐：代码合成（mood、bpm、seed）」。
