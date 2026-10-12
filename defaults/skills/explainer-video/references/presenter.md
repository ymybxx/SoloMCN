# 解说员（系列配了角色时）

`get_item` 返回了 `presenter`（系列配了解说员）时，由她出镜解说。她是**配角**：画面的主体始终是内容，她在旁边讲。

1. **留位置**：在 `frame.md` 的「本片规矩」里写明：竖屏右侧约 40% 宽、画面高度 50%–83% 这块留给解说员，那里不放字和关键画面（字幕条在她下面，不受影响）；横屏是右侧约 30% 宽、下半部分。需要满屏的镜头（大图、录屏特写）可以让她退场，内容放回整屏。
2. **写参数** `presenter/spec.json`（在项目目录里）：
   ```json
   {
     "character": "<presenter.dir>",
     "width": 1080, "height": 1920,
     "duration": 57.3,
     "voices": [ {"file": "assets/voice/01.wav", "start": 0}, {"file": "assets/voice/02.wav", "start": 3.98} ],
     "cues": [ {"at": 0, "expr": "talk"}, {"at": 9.4, "expr": "surprised"}, {"at": 11.2, "expr": "talk"} ],
     "layout": [ {"at": 0, "side": "right", "size": 0.34}, {"at": 20.9, "hidden": true}, {"at": 26.5, "side": "right", "size": 0.34} ]
   }
   ```
   - `width`/`height`：和成片一样（看 BRIEF 的 `aspect`：竖屏 1080×1920，横屏 1920×1080）。
   - `voices`：`audio_meta.json` 里每个镜头的配音文件，`start` 是那个镜头的起点（STORYBOARD 同步后的时长累加）。嘴型和点头按它们的音量走。
   - `cues`：什么时候换什么表情，只用 `presenter.expressions` 里有的。讲解（`talk`）打底；惊讶（`surprised`）用在反转、意外的数字；得意（`smug`）用在「我们做到了」；疑惑（`think`）用在抛问题；无奈（`shrug`）、吐槽（`roast`）用在槽点；认真（`serious`）用在提醒和风险；开心（`cheer`）用在成功。3–8 秒换一次，跟着台词情绪走，不要每句都换。
   - `layout`：默认右侧、`size` 0.34（角色图高占画面三分之一）、底边在字幕条上方。`hidden: true` 让她滑出去，下一条再滑回来；每次出场至少 4 秒，别频繁进出。内容在右边的镜头可以换到 `"side": "left"`。
3. **先在后台画好**：配音做完、`sync-durations` 之后就写好 spec，**放到后台**运行 `node <本技能目录>/scripts/presenter.mjs --spec presenter/spec.json`（用后台 Bash，不要等它），然后接着做镜头。它只依赖配音、表情和位置，和镜头的制作同时进行，不占总时间。
4. **审片时一起看**：渲染前的审片拼图会把她叠进去（见 `review.md` 的「渲染前：审片」）。挡住了内容、表情和台词情绪对不上，就改 spec 里那一段的 `layout` 或 `cues`，再在后台跑一次（只重画变了的这一版，几分钟）。
5. **叠上去**：先确认第 3 步那个后台任务已经结束（没结束就等它，两个同时跑会互相覆盖），渲染出 `renders/video.mp4` 后运行 `node <本技能目录>/scripts/presenter.mjs --spec presenter/spec.json --overlay renders/video.mp4`。spec、配音、角色图都没变时它直接复用画好的角色层，几秒就叠完；变了会自动重画。它把没叠的原片存成 `renders/video-base.mp4`，叠好的写回 `renders/video.mp4`。尺寸和成片对不上会直接报错，按提示改 spec。

不要在画面里另外再画一个角色，也不要用代码画她；她只来自角色库的图。
