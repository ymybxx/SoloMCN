# 原片剪辑：生成视频

画面全是 `assets` 里的真实片段（多数是调研时从 B站剪的整首直拍），声音是一条主音轨的歌曲原声，各片段按音轨对齐、踩着拍子切换：同一个动作接着跳，造型一下变了，这就是「一键换装」。用本技能目录（stage-montage）下的 `scripts/montage.mjs`（ffmpeg 逐段截取拼接，帧精确，几分钟出片），不用 HyperFrames 渲染。

1. **建目录** `videos/<两到四个英文单词>-<内容 id>/`（已有没做完的就接着做；已经有 `renders/video.mp4` 的是重新生成，新建一个加 `-v2`、`-v3` 的目录），里面放 `montage.json`。素材路径直接写相对这个目录的路径（例如 `../_assets/<内容 id>/xxx.mp4`），不要复制大文件。
2. **对齐**：`node <本技能目录>/scripts/montage.mjs align --master <主音轨素材> <各片段...>`。每条返回 `offset`（片段时间 − 主音轨时间）、`z`（可信度）、`segments`（能用的时间段和各段时间差）、`ok`。`ok` 为 false 的不用，在 notes 里记原因（多半是编曲不同、不是同一首、音质太差）。主音轨素材本身如果主角不在画面里（官方 MV 的群舞镜头），只用声音，不放进 sources。
3. **写 `montage.json`**：
   ```json
   {
     "size": [1920, 1080], "fps": 30,
     "audio": { "file": "../_assets/<id>/master.mp4", "start": 3.2, "end": 182.5, "fadeIn": 0.4, "fadeOut": 1.5 },
     "sources": [
       { "id": "d1", "file": "../_assets/<id>/a.mp4", "offset": 21.368, "segments": [ {"from": 0, "to": 191.8, "offset": 21.368} ], "label": "0726 梦寐以求", "x": 0.5, "y": 0.45, "zoom": 1.0, "exclude": [[88, 92]] }
     ],
     "auto": { "beatsPerCut": 4, "seed": 1, "sections": [ {"from": 60, "to": 75, "beatsPerCut": 2} ] },
     "pins": [ {"from": 120.4, "to": 126.6, "src": "d1"} ],
     "texts": [ {"text": "<歌手>《<歌名>》一键换装", "from": 3.2, "to": 6, "size": 0.065, "y": 0.12} ],
     "labels": true
   }
   ```
   - `size` 按脚本【剪辑方案】的画幅；`audio.start/end` 按脚本的主音轨范围，总长不超过系列时长。
   - **超时长要砍中间**：`node montage.mjs skips --master <主音轨素材> --within <允许砍的范围，如 90,150>` 列出能无缝砍掉的整数个八拍（`score` 越高，砍点前后的声音越接得上），挑分最高、长度够用的一两段写进 `audio.skip`（`[[105.378, 111.586]]`，主音轨时间）。砍点之后会自动强制换一场接上，不会出现同一场画面跳帧。其余时间（`pins`、`sections`、`texts`）照常写主音轨时间。开头、结尾能直接收短的优先收短，不够再砍中间；notes 里写砍了哪段。
   - `sources` 用 align 的 `offset` 和 `segments` 原样填；`label` 是画面左下角的场次小字（脚本素材表里的），不要就不填或 `labels: false`。
   - `x`/`y`/`zoom`：主角在画面里的位置和放大倍数。直拍一般主角已经居中，用默认；主角偏了、太小，就调 `x`（0–1，主角的横向位置）、`zoom`（1.0–1.6，放大会损失清晰度，480P 素材不要放大）。素材和成片横竖屏不一致时一定要设 `x`，保证裁出来的是主角。
   - `exclude`：某条片段在某段主音轨时间里挡镜头、失焦、转去拍别人，就排除掉。
   - `auto`：每几拍切一次（`beatsPerCut`），`sections` 给副歌、鼓点密的地方加快到 2 拍；`pins`：脚本里要停住的名场面，指定用哪一场、从几秒到几秒。拍点用 `beats` 子命令看（`node montage.mjs beats --master <主音轨素材>`，会给 BPM 和候选），时间都是主音轨时间。
4. **认主角（可选，默认不做）**：`node montage.mjs track --spec montage.json` 会认出每条直拍里的主角，把拍到别人、被挡的时段写进 `autoExclude`；再加 `"reframe": true` 会按主角位置放大居中。代价是排除偏保守、可选镜头变少，放大后画面变软，整片切点也会跟着变。**默认按正常方式剪，靠第 10 步审片只修出问题的几刀**；只有素材几乎全是多人远景、主角经常不在画面中间时才用这一步。
5. **查对齐和构图**：`node montage.mjs compare --spec montage.json --at <5–8 个时间点，覆盖主歌、副歌、舞蹈段>`，生成 `review/compare.jpg`：每一行是同一时刻、每一列是一条片段。读这张图：同一行的动作应该是同一拍的同一个动作；对不上的片段（动作明显不同步）先在 notes 记下，把它 `use: false` 或用 `exclude` 去掉那一段；主角不在中间的调 `x`/`zoom`，再出一次对比图确认。
6. **排切点**：
   - **按歌曲结构排**（舞台类默认）：`montage.json` 里写 `"structure": true`，plan 会先分析整首歌（`node montage.mjs sections --master <主音轨>` 可以单独看）：小节第一拍、4 小节一句、每句能量 0 安静–3 高潮、爆点。切点都落在小节第一拍；安静、平稳、推进段 8 拍一换，高潮 4 拍，爆点之后那一句 2 拍（可用 `"structure": {"pace": {"0": 8, "1": 8, "2": 8, "3": 4}, "dropBurst": 2}` 调）。plan 会顺带按段落地图给每一刀挑换装转场，写进 `cuts[].fx`。
   - **换装转场**（`node montage.mjs fx --spec montage.json` 可单独重挑，切点不动）：段落开头用扫描换装（`scan`，全片最多 4 次）或节拍光门（`gate`），爆点用节拍光门，高潮段偶尔残影换装（`echo`）、动势甩切（`whip`）、色彩脉冲（`pulse`），推进段偶尔甩切、脉冲，安静段偶尔柔和叠化（`dissolve`），其余硬切。特效（不含叠化）不超过 20%，同一种不连用。要指定某一刀，就改它的 `fx`（`{"type": "scan", "frames": 8}`）并加 `"fxManual": true`。转场和光的颜色用 `"theme": {"colors": ["#浅色", "#主题色"]}`（从歌名、歌词、舞台主色里定两个），不填用暖白和品红。转场要配合 `"lock": {"mode": "cut"}`（换装瞬间对齐）一起用，旧画面和新画面才对得上。
   - 不按结构排时：`node montage.mjs plan --spec montage.json`，切点写回 `cuts`（每个切点 `at`、`src`、`offset`）。挑场次时会顺带看画面：在不和最近两刀同场、各场出场次数差不多的前提下，优先选主角清楚、站在中间的那场（第一次要做人体检测，几分钟，结果缓存在 `track/`）。这只是偏好，不排除素材、不放大，剪完照样要第 10 步审片；`"preferClear": false` 可以关掉。看一遍：同一场不要连着出现，名场面停住的位置对。要微调就直接改 `cuts`（单个切点可以加 `nudge` 秒数微调这一镜的起点、`zoom`/`x` 覆盖这一镜的构图），改了就不要再跑 plan（会覆盖）。`pins` 指定的那一场在那段被 `autoExclude` 排除了（主角被挡），plan 会报错：换一场能用的，或者挪一下时间。
7. **「贴合换装」（换装视频默认，要的是「从头到尾像一个人、只换了衣服」）**：素材按调研的体检结果挑：`get_item` 的 assets 里 `vet.verdict` 是「不适合」的不放进 `sources`；同一套造型的几条（`note` 里同一个「造型：…」标签）都放进去，并写同一个 `"look": "<造型标签>"`，全局挑点会把它们当同一套造型的不同机位（之间不切换），选动作最对得上的那条。`montage.json` 写 `"schedule": {"holdCost": 0.2}` 和 `"lock": {"mode": "full", "background": false, "matchCut": 3, "grade": true, "zoomMin": 1.15, "zoomMax": 1.75, "smooth": 0.4}`，然后 `node montage.mjs plan --spec montage.json`（等同 `schedule`）。它会：提取各场画面里每个人的骨架和外观（`pose/<id>.cands.json`），逐帧认出主角（`pose/<id>.json`：直拍里最常出现、最靠中间的那个外观是他；每场自己学头发、衣服、整体外观哪项最能把他和队友分开；前后帧不瞬移；他和长得像的队友挤在一起、认不准的帧标成没认准，不硬跟别人）；只在前后都认得准他、而且他能放回画面中间的拍子停留和换装（某一场突然被挡、挤在一起时，允许「脱身」换到一场此刻看得清的）；渲染时锁定也只跟这个逐帧认出来的人，认不到的几帧补插值；把全曲每一拍、每两场之间的动作差都算出来，用动态规划只在两场动作几乎一样（差 ≤ 0.14，最多放宽到 0.18 但更贵）、而且两边能放到画面同一位置（不要求正中、不贴边）的那一拍换装；按段落能量定节奏（高潮最短 4 拍、推进 6 拍、安静 8 拍）；能用时间少的场次换进去有额外奖励；每次换装默认 5 帧人形变形过渡（`schedule.fx` 可改）。渲染时用脖子、肩、胯、鼻子、眼睛 8 个点拟合位置、大小、倾斜，让新造型和旧造型的身体、脸重合，再约 1 秒回到标准位置。`node montage.mjs schedule --spec montage.json` 加环境变量 `SCHED_DEBUG=1` 会打印每场能用的拍数、能换进各场的次数：某一场能换进的次数很少，多半是素材本身（多机位精剪、他总在边上），换素材比调参数有效。
   旧做法「丝滑换装」：`montage.json` 写
   `"structure": true, "fx": {"style": "silky", "budget": 0.12}, "lock": {"mode": "full", "background": false, "matchCut": 3, "grade": true, "zoomMin": 1.15, "zoomMax": 1.6, "smooth": 0.4}`。
   plan 会逐帧提取各场主角的骨架（缓存在 `pose/`），自动定一个统一大小（`lock.torso`）；每次换装只选「能锁得住」（能缩放到统一大小、能放到画面中间）而且和上一套动作最一致的场次，并在前后 0.3 秒里挪到动作最一致的接点（写进切点的 `nudge`）。没有合格的就先不换，多停几拍（`maxHold` 秒，默认 10；动作差上限 `matchMax`，默认 0.3）。「锁得住」在切点前后 0.25 秒最严（偏离正中不超过 5%），看得见的关节少于 7 个（被挡）的镜头不选也不停留；`zoomMin` 建议 1.2，给裁切框留移动余地。渲染时新造型开头先放在上一套结尾的位置和大小，再约 1 秒回到正中。渲染后跑 `node montage.mjs check --spec montage.json --video renders/video.mp4`：逐刀量成片里切点前后他的位置、大小差多少，列出跳位的刀和他被挡住超过 1 秒的时段；它会把旁边的人量成他（误报），列出来的刀要截图确认，真跳的再换；做完先用逐场认人小图（每秒一张主角截图）人工核对一遍，认成队友的时段写进 `exclude`；所有场次都挡、人挤人的队形段落（音乐必须完整，不剪），写进 `schedule.array: [{"span": [起, 止], "hold": 2}]`（主音轨时间）：这一段不锁定贴合，每 hold 拍换到此刻最看得清他（认得准、正脸、没被挡）的一场、放在画面中间，用斜条纹转场换场，偶尔两场并排分身；进出接上前后的锁定画面。列出的被挡时段超过 1.4 秒的，把那一段（主音轨时间，前后各放宽 0.5 秒）写进那一场 source 的 `exclude`，去掉 `cuts` 重新 plan、渲染、再 check。渲染时人物全程固定在同一位置、同样大小，舞台不虚化；转场只用作用在人身上的扫描换装和残影换装，其余是对准动作的硬切。审片时重点看切点前后一帧他的位置、大小、动作是否一致，不一致的刀用 `audit --fix --only` 换掉，或者在 `exclude` 里排除那场那一段后重新 plan。
8. **换装对齐（其他风格）**：舞台类默认 `"lock": {"mode": "cut"}`：只在换装瞬间对齐位置和大小，前后 0.5 秒（`ease`）平滑交还原机位，舞台和运镜都保留；同时统一 8 场的调色（`grade`），动作卡点微调（`matchCut`，在前后 3 帧里挑新旧两场姿态最像的一帧切）。脚本或修改意见要求「原地换装」「人物全程不动」时才用全程锁定 `"lock": {"transition": "dissolve", "frames": 6}`。渲染时逐帧找主角的骨架（macOS Vision 人体姿态，不做人脸识别），把他钉在画面同一位置（`x`/`y` 是脖子的位置，默认 0.5/0.3）、同样大小（自动统一，放大 `zoomMin`–`zoomMax`，默认 1.1–1.45），背景和周围的人虚化压暗（`background: {blur, dim, desat}`，`false` 关掉），原画不够的地方用虚化边缘补。换装过渡 `transition`：`dissolve` 渐变叠化（默认，带一点柔光）、`flash` 闪白、`mix` 平时渐变、`strongEvery` 每几刀闪白一次。各素材要保持清楚的区域（比如底部水印）写在 source 的 `keep: [[x, y, w, h]]`（素材坐标 0–1）。它依赖认主角的结果（会自动跑），渲染完一定要按第 10 步审片：认不出主角的刀会锁到别人身上（比如前面的伴舞），用 `audit --fix --only` 换掉。
9. **渲染**：`node montage.mjs render --spec montage.json --out renders/video.mp4`。顺带写出 `renders/video-cuts.json`（切点表）和 `snapshots/contact-sheet.jpg`。
10. **审片（多人画面必须做，只修出问题的刀）**：
   - `node montage.mjs audit --spec montage.json` 列出可疑的刀（画面里可能是别人、主角被挡、太小）。它第一次跑会顺带做人体检测，几分钟。
   - 体检有误报也有漏报：把标出来的每一刀在成片里截一张图（`ffmpeg -ss <这刀中间的秒数> -i renders/video.mp4 -frames:v 1`，拼成一张图看），再把 `renders/video-cuts.json` 里每一刀都过一遍缩略图（`snapshots/contact-sheet.jpg` 不够细就按切点各截一张），找出真正有问题的：正中是别人、主角被工作人员或摄影师挡住、主角小到认不出、整帧模糊。
   - 只把确认有问题的刀交给 `node montage.mjs audit --spec montage.json --fix --only <这几刀的成片秒数，逗号分隔> --out montage-fixed.json`，它把这几刀换成同一时刻主角清楚的另一场，其余切点、节奏、构图都不动；然后 `render --spec montage-fixed.json` 重渲，换上的画面再截图核对一遍。换上的还不行，就对比 `compare` 图手动改那一刀的 `src` 和 `offset`（前后两刀不能是同一场）。最多改一轮，改不好的记进 notes。
   - 不要因为体检就整片加 `reframe` 或重新 `plan`：大部分镜头本来没问题，重排会把它们也改掉。读 `snapshots/contact-sheet.jpg`，挑 3–5 个切点前后各截一帧（`ffmpeg -ss <秒> -i renders/video.mp4 -frames:v 1`）看：切换前后动作是不是连着的、主角在不在画面里、字有没有挡脸、有没有黑帧。有硬伤改 `montage.json` 重渲一次，最多改一轮。
11. 不加配音、不加 BGM、不加解说员（脚本明确要求的除外）。素材的 UP 主和原视频链接写进 notes（来源记在后台），不加到画面上。

做完回到 make-video 的「登记」和「汇报」。
