// 原地换装渲染：逐帧找主角的骨架，把他钉在画面同一个位置、同样大小；背景和周围的人虚化压暗；切点加闪白和放大回弹。
// 只用 macOS 自带的 Vision（人体姿态、人像分割）和 Core Image，不做人脸识别。montage.mjs 的 render 在 spec 里有 "lock" 时调用它。
//   lockfx <job.json>
// job: { size:[W,H], fps, out, target:{x,y,torso}, zoomMin, zoomMax, smooth, background:{blur,dim,desat}|null,
//        flash:{light,strong,frames,punch}, transition:{type:dissolve|flash|mix,frames}, mode:full|cut, ease, grade, matchCut, segments:[{file,start,frames,hint:{cx,cy}|null,strong,keep:[[x,y,w,h]]}] }
// target.x/y 是脖子在成片里的位置（0–1，左上为原点），torso 是脖子到胯的长度占成片高度的比例（不填就按全片自动定）；keep 是要保持清楚的区域（素材坐标 0–1，比如底部水印）。
import AVFoundation
import CoreImage
import Foundation
import Vision

struct Job: Decodable {
  struct Target: Decodable { let x: Double; let y: Double; let torso: Double? }
  struct Background: Decodable { let blur: Double; let dim: Double; let desat: Double }
  struct Flash: Decodable { let light: Double; let strong: Double; let frames: Int; let punch: Double }
  // 换装过渡：dissolve 渐变（新旧两场叠化，中间带一点柔光）/ flash 闪白 / mix 平时渐变、强调的那几刀闪白
  struct Transition: Decodable { let type: String; let frames: Int }
  struct Hint: Decodable { let cx: Double; let cy: Double }
  // track：这一刀里认人得到的主角框 [相对这一刀开头的秒数, cx, cy, w, h]（素材坐标 0–1），用来认准是他
  // necks：逐帧认好的主角脖子位置 [相对这一刀开头的秒数, x, y]（素材坐标 0–1）。有它就只跟这个人，认不到就补插值，绝不改跟旁边的人
  // fx：这一刀开头的换装转场（cut 硬切 / dissolve 叠化 / scan 扫描换装 / echo 残影换装 / gate 节拍光门 / whip 动势甩切 / pulse 色彩脉冲 / flash 闪白），不填就用全局 transition
  struct Segment: Decodable { let file: String; let start: Double; let frames: Int; let hint: Hint?; let track: [[Double]]?; let necks: [[Double]]?; let free: Bool?; let array: Bool?; let strong: Bool?; let keep: [[Double]]?; let fx: Transition? }
  struct Theme: Decodable { let colors: [String]? }
  let size: [Int]; let fps: Double; let out: String
  let target: Target; let zoomMin: Double; let zoomMax: Double; let smooth: Double
  let background: Background?; let flash: Flash?; let transition: Transition?; let segments: [Segment]
  // mode：full 全程锁定（默认）/ cut 只在换装瞬间对齐，前后 ease 秒里平滑交还原机位
  // grade：各场统一调色；matchCut：换装时在前后几帧里挑新旧两场姿态最像的那一帧来切
  let mode: String?; let ease: Double?; let grade: Bool?; let matchCut: Int?
  let theme: Theme?
  let gains: [String: [Double]]? // 由 montage 统一算好的各片段调色增益（有就不再自己算）
}

func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }

let job: Job = {
  guard CommandLine.arguments.count >= 2, let d = FileManager.default.contents(atPath: CommandLine.arguments[1]) else { fail("用法：lockfx <job.json>") }
  do { return try JSONDecoder().decode(Job.self, from: d) } catch { fail("job.json 格式不对：\(error)") }
}()
let W = Double(job.size[0]), H = Double(job.size[1])
let ctx = CIContext(options: [.cacheIntermediates: false])

// ---------- 按时间取帧：输出第 k 帧取素材里时间最接近 start + k/fps 的那一帧 ----------
final class FrameSource {
  let reader: AVAssetReader; let output: AVAssetReaderTrackOutput
  var last: (t: Double, buf: CVPixelBuffer)?; var next: (t: Double, buf: CVPixelBuffer)?
  let size: CGSize
  init(file: String, start: Double, dur: Double) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: file))
    guard let track = asset.tracks(withMediaType: .video).first else { fail("没有视频轨：\(file)") }
    size = track.naturalSize.applying(track.preferredTransform).applying(.identity)
    reader = try! AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: max(0, start - 0.1), preferredTimescale: 600), duration: CMTime(seconds: dur + 0.3, preferredTimescale: 600))
    output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output); reader.startReading()
  }
  private func read() -> (Double, CVPixelBuffer)? {
    guard let s = output.copyNextSampleBuffer(), let b = CMSampleBufferGetImageBuffer(s) else { return nil }
    return (CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s)), b)
  }
  func frame(at t: Double) -> CVPixelBuffer? {
    if next == nil { next = read() }
    while let n = next, n.t < t { last = n; next = read() }
    guard let n = next else { return last?.buf }
    guard let l = last else { return n.buf }
    return abs(l.t - t) <= abs(n.t - t) ? l.buf : n.buf
  }
}

// ---------- 分析：每帧找主角的脖子、躯干长度、身体范围和人像遮罩 ----------
// kp：对齐用的 8 个点（脖子、左右肩、左右胯、鼻子、左右眼），素材像素坐标
struct Body { var neck: CGPoint; var torso: Double; var box: CGRect; var pose: [CGPoint?]; var kp: [CGPoint?] }
let KP_JOINTS: [VNHumanBodyPoseObservation.JointName] = [.neck, .leftShoulder, .rightShoulder, .leftHip, .rightHip, .nose, .leftEye, .rightEye] // 素材像素坐标，原点左上；pose 是各关节相对脖子、按身体大小归一后的位置
let POSE_JOINTS: [VNHumanBodyPoseObservation.JointName] = [.leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist, .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle]
// 两个姿态差多少：共同认到的关节平均距离（按身体大小归一），共同关节太少就当差很多
func poseDist(_ a: [CGPoint?], _ b: [CGPoint?]) -> Double {
  var s = 0.0, n = 0
  for (p, q) in zip(a, b) { if let p = p, let q = q { s += hypot(p.x - q.x, p.y - q.y); n += 1 } }
  return n >= 5 ? s / Double(n) : .infinity
}
func bodies(_ obs: [VNHumanBodyPoseObservation], _ w: Double, _ h: Double) -> [Body] {
  obs.compactMap { o in
    guard let pts = try? o.recognizedPoints(.all) else { return nil }
    func p(_ k: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
      guard let q = pts[k], q.confidence > 0.25 else { return nil }
      return CGPoint(x: q.location.x * w, y: (1 - q.location.y) * h)
    }
    guard let neck = p(.neck) else { return nil }
    let hips = [p(.leftHip), p(.rightHip), p(.root)].compactMap { $0 }
    // 身体大小：脖子到胯的长度和肩宽×1.5 取大的（弯腰时躯干量短了、侧身时肩宽量窄了，取大的那个更稳）
    var torso = 0.0
    if !hips.isEmpty {
      let hy = hips.map { $0.y }.reduce(0, +) / Double(hips.count), hx = hips.map { $0.x }.reduce(0, +) / Double(hips.count)
      torso = hypot(hx - neck.x, hy - neck.y)
    }
    if let l = p(.leftShoulder), let r = p(.rightShoulder) { torso = max(torso, hypot(l.x - r.x, l.y - r.y) * 1.5) }
    if torso == 0 { return nil }
    let all = pts.values.filter { $0.confidence > 0.2 }.map { CGPoint(x: $0.location.x * w, y: (1 - $0.location.y) * h) }
    let xs = all.map { $0.x }, ys = all.map { $0.y }
    let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    let pose = POSE_JOINTS.map { j in p(j).map { CGPoint(x: ($0.x - neck.x) / torso, y: ($0.y - neck.y) / torso) } }
    let kp = KP_JOINTS.map { p($0) }
    return torso > 8 ? Body(neck: neck, torso: torso, box: box, pose: pose, kp: kp) : nil
  }
}

func median(_ a: [Double]) -> Double { let s = a.sorted(); return s.isEmpty ? 0 : s[s.count / 2] }

// ---------- 输出 ----------
let outURL = URL(fileURLWithPath: job.out)
try? FileManager.default.removeItem(at: outURL)
let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(W), AVVideoHeightKey: Int(H),
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 24_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
])
vin.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vin, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: Int(W), kCVPixelBufferHeightKey as String: Int(H)])
writer.add(vin); writer.startWriting(); writer.startSession(atSourceTime: .zero)
var outIndex: Int64 = 0
let rgb = CGColorSpace(name: CGColorSpace.sRGB)!

var report: [[String: Any]] = []
let poseReq = VNDetectHumanBodyPoseRequest()
let segReq = VNGeneratePersonSegmentationRequest()
segReq.qualityLevel = .balanced
segReq.outputPixelFormat = kCVPixelFormatType_OneComponent8

let tType = job.transition?.type ?? (job.flash == nil ? "none" : "flash")
// 每一刀开头用什么转场：片段自己写了就用自己的，否则用全局的（mix = 平时叠化、强调的刀闪白）
func fxOf(_ si: Int) -> (type: String, frames: Int) {
  if let f = job.segments[si].fx { return (f.type, max(1, f.frames)) }
  let t = tType == "mix" ? ((job.segments[si].strong ?? false) ? "flash" : "dissolve") : tType
  return (t, max(2, job.transition?.frames ?? (job.flash?.frames ?? 6)))
}
// 叠化、扫描、残影、光门、甩切要用到上一刀切点之后的几帧：上一刀多分析、多渲染这些 tail 帧
let NEEDS_TAIL: Set<String> = ["dissolve", "scan", "echo", "gate", "whip", "morph", "stripes"]
func tailOf(_ si: Int) -> Int {
  guard si < job.segments.count - 1 else { return 0 }
  let n = fxOf(si + 1)
  return NEEDS_TAIL.contains(n.type) ? n.frames : 0
}
// 主题色（转场的光、残影的染色、色彩脉冲）：没给就用暖白和品红
func ciColor(_ hex: String) -> CIColor {
  var v: UInt64 = 0; Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
  return CIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255)
}
let themeColors = (job.theme?.colors ?? []).map(ciColor)
let C1 = themeColors.first ?? CIColor(red: 1, green: 0.93, blue: 0.82)
let C2 = themeColors.dropFirst().first ?? CIColor(red: 1, green: 0.2, blue: 0.45)

let M = max(0, job.matchCut ?? 0)
struct Plan { var neckX: [Double]; var neckY: [Double]; var lost: [Double]; var boxes: [CGRect?]; var poses: [[CGPoint?]?]; var kps: [[CGPoint?]?]; var torso: Double; var found: Int; var sw: Double; var sh: Double; var pre: Int; var file: String }
var plans: [Plan] = []
var colorSamples: [String: [[Double]]] = [:] // 每条素材抽样的平均颜色，统一调色用
// 第一遍：每一刀逐帧找主角。前后各多分析 matchCut 帧，给动作卡点微调留余地
for (si, seg) in job.segments.enumerated() {
  let pre = si > 0 ? M : 0
  let total = pre + seg.frames + tailOf(si) + M
  let t0 = seg.start - Double(pre) / job.fps
  let src = FrameSource(file: seg.file, start: t0, dur: Double(total) / job.fps)
  let sw = Double(src.size.width), sh = Double(src.size.height)
  var picked: [Body?] = []
  var prev: Body? = nil
  for k in 0..<total {
    guard let buf = src.frame(at: t0 + Double(k) / job.fps) else { picked.append(nil); continue }
    if job.grade == true, k % 6 == 0 {
      var px = [Float](repeating: 0, count: 4)
      let avg = CIImage(cvPixelBuffer: buf).applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: CGRect(x: 0, y: 0, width: sw, height: sh))])
      ctx.render(avg, toBitmap: &px, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: rgb)
      colorSamples[seg.file, default: []].append([Double(px[0]), Double(px[1]), Double(px[2])])
    }
    let h = VNImageRequestHandler(cvPixelBuffer: buf, options: [:])
    try? h.perform([poseReq])
    let cands = bodies(poseReq.results ?? [], sw, sh)
    // 认人：附近 0.3 秒内有认人框时，只认脖子落在框里的那个人（框的上半部分），离框顶中间最近的；
    // 没有框就和上一帧连贯；第一帧还没有参照，就用画面中间偏大的人
    let tsec = Double(k - pre) / job.fps
    let tb = (seg.track ?? []).filter { $0.count == 5 && abs($0[0] - tsec) <= 0.3 }.min { abs($0[0] - tsec) < abs($1[0] - tsec) }
    var best: Body? = nil
    let nk = seg.necks ?? []
    if !nk.isEmpty {
      // 逐帧认人结果：取前后最近的两个点插值，离得超过 0.25 秒就当这一帧没认到
      let a = nk.last { $0[0] <= tsec + 1e-6 }, b = nk.first { $0[0] >= tsec - 1e-6 }
      var ref: CGPoint? = nil
      if let a = a, let b = b, b[0] - a[0] <= 0.35 {
        let f = b[0] - a[0] < 1e-6 ? 0 : (tsec - a[0]) / (b[0] - a[0])
        ref = CGPoint(x: (a[1] + (b[1] - a[1]) * f) * sw, y: (a[2] + (b[2] - a[2]) * f) * sh)
      } else if let c = [a, b].compactMap({ $0 }).min(by: { abs($0[0] - tsec) < abs($1[0] - tsec) }), abs(c[0] - tsec) <= 0.12 {
        ref = CGPoint(x: c[1] * sw, y: c[2] * sh)
      }
      if let ref = ref {
        best = cands.filter { hypot($0.neck.x - ref.x, $0.neck.y - ref.y) < sw * 0.06 }.min { hypot($0.neck.x - ref.x, $0.neck.y - ref.y) < hypot($1.neck.x - ref.x, $1.neck.y - ref.y) }
      }
      picked.append(best)
      if best != nil { prev = best }
      continue
    }
    if let tb = tb {
      let box = CGRect(x: (tb[1] - tb[3] / 2) * sw, y: (tb[2] - tb[4] / 2) * sh, width: tb[3] * sw, height: tb[4] * sh).insetBy(dx: -tb[3] * sw * 0.15, dy: -tb[4] * sh * 0.1)
      let ref = CGPoint(x: box.midX, y: box.minY + box.height * 0.2)
      best = cands.filter { box.contains($0.neck) && $0.neck.y < box.minY + box.height * 0.55 }.min { hypot($0.neck.x - ref.x, $0.neck.y - ref.y) < hypot($1.neck.x - ref.x, $1.neck.y - ref.y) }
    }
    if best == nil {
      let ref = prev?.neck ?? CGPoint(x: (seg.hint?.cx ?? 0.5) * sw, y: ((seg.hint?.cy ?? 0.45) - 0.15) * sh)
      best = cands.min { a, b in
        let da = hypot(a.neck.x - ref.x, a.neck.y - ref.y) / sw - (prev == nil ? a.torso / sh * 0.3 : 0)
        let db = hypot(b.neck.x - ref.x, b.neck.y - ref.y) / sw - (prev == nil ? b.torso / sh * 0.3 : 0)
        return da < db
      }
      // 没有认人框时，和上一帧跳太远（超过画面宽 12%）就当没认到
      if let b = best, let p = prev, hypot(b.neck.x - p.neck.x, b.neck.y - p.neck.y) > sw * 0.12 { best = nil }
    }
    picked.append(best)
    if best != nil { prev = best }
  }
  // 补洞：没认到的帧用前后插值；整段都没认到就用画面中间
  let known = picked.enumerated().compactMap { $0.element == nil ? nil : ($0.offset, $0.element!) }
  var neckX = [Double](repeating: (seg.hint?.cx ?? 0.5) * sw, count: total), neckY = [Double](repeating: sh * 0.3, count: total)
  var boxes = [CGRect?](repeating: nil, count: total)
  if !known.isEmpty {
    for k in 0..<total {
      let before = known.last { $0.0 <= k }, after = known.first { $0.0 >= k }
      let (a, b) = (before ?? after!, after ?? before!)
      let f = a.0 == b.0 ? 0 : Double(k - a.0) / Double(b.0 - a.0)
      neckX[k] = a.1.neck.x + (b.1.neck.x - a.1.neck.x) * f
      neckY[k] = a.1.neck.y + (b.1.neck.y - a.1.neck.y) * f
      boxes[k] = (abs(k - a.0) <= abs(b.0 - k) ? a.1 : b.1).box
    }
  }
  // 认不到他的时段：离最近一次认到超过 0.25 秒开始，平滑交还原机位（直拍的摄影师本来就跟着他），0.6 秒时完全交还；认回来再锁住
  var lost = [Double](repeating: 0, count: total)
  if !known.isEmpty {
    var ki = 0
    for k in 0..<total {
      while ki + 1 < known.count && known[ki + 1].0 <= k { ki += 1 }
      var d = abs(known[ki].0 - k); if ki + 1 < known.count { d = min(d, abs(known[ki + 1].0 - k)) }
      let x = (Double(d) / job.fps - 0.25) / 0.35
      lost[k] = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
    }
  } else { lost = [Double](repeating: 1, count: total) }
  // 平滑：前后各 smooth/2 秒的移动平均，去掉骨架识别的抖动
  let r = max(1, Int(job.smooth * job.fps / 2))
  func smoothed(_ v: [Double]) -> [Double] { v.indices.map { i in let lo = max(0, i - r), hi = min(v.count - 1, i + r); return v[lo...hi].reduce(0, +) / Double(hi - lo + 1) } }
  // 这一刀的身体大小取偏大的读数（第 75 百分位），弯腰、转身那几帧量小了不算
  let ts = known.map { $0.1.torso }.sorted()
  plans.append(Plan(neckX: smoothed(neckX), neckY: smoothed(neckY), lost: lost, boxes: boxes, poses: picked.map { $0?.pose }, kps: picked.map { $0?.kp }, torso: ts.isEmpty ? 0 : ts[min(ts.count - 1, Int(Double(ts.count) * 0.75))], found: known.count, sw: sw, sh: sh, pre: pre, file: seg.file))
  FileHandle.standardError.write("\r分析 \(si + 1)/\(job.segments.count)".data(using: .utf8)!)
}
// 动作卡点微调：每一刀的开头在 ±matchCut 帧里挑和上一刀最后一帧姿态最像的
var nudge = [Int](repeating: 0, count: job.segments.count)
if M > 0 {
  for si in 1..<job.segments.count {
    let a = plans[si - 1], b = plans[si]
    let outIdx = a.pre + nudge[si - 1] + job.segments[si - 1].frames - 1
    guard outIdx >= 0, outIdx < a.poses.count, let pa = a.poses[outIdx] else { continue }
    var best = (0, Double.infinity)
    for n in -M...M {
      let j = b.pre + n
      guard j >= 0, j < b.poses.count, let pb = b.poses[j] else { continue }
      // 不动更好：同样像的时候倾向不挪（每挪一帧加一点代价）
      let d = poseDist(pa, pb) + Double(abs(n)) * 0.02
      if d < best.1 { best = (n, d) }
    }
    if best.1.isFinite { nudge[si] = best.0 }
  }
}
// 统一调色：各条素材的平均颜色往全体平均靠 70%，每个通道最多调 ±15%
var gains: [String: [Double]] = job.gains ?? [:]
if job.grade == true, job.gains == nil, !colorSamples.isEmpty {
  let means = colorSamples.mapValues { xs in (0..<3).map { c in xs.map { $0[c] }.reduce(0, +) / Double(xs.count) } }
  let target = (0..<3).map { c in means.values.map { $0[c] }.reduce(0, +) / Double(means.count) }
  for (f, m) in means { gains[f] = (0..<3).map { c in min(1.15, max(0.87, pow(target[c] / max(m[c], 0.01), 0.7))) } }
}
// 统一大小：每一刀不放大时主角躯干在成片里多长；目标取偏大的那头（第 85 百分位 × 最小放大），大的少放大，小的多放大
let natural = plans.map { p in p.torso * max(W / p.sw, H / p.sh) }.filter { $0 > 0 }
let targetTorso = job.target.torso.map { $0 * H } ?? ((natural.sorted().dropFirst(Int(Double(natural.count) * 0.85)).first ?? natural.max() ?? H * 0.3) * job.zoomMin)

var prevTail: [CVPixelBuffer] = []
var prevGhost: [CIImage] = []
let frameRectAll = CGRect(x: 0, y: 0, width: W, height: H)
func solid(_ c: CIColor, _ a: Double) -> CIImage { CIImage(color: CIColor(red: c.red, green: c.green, blue: c.blue, alpha: CGFloat(a))).cropped(to: frameRectAll) }
func additive(_ img: CIImage, _ over: CIImage) -> CIImage { over.applyingFilter("CIAdditionCompositing", parameters: [kCIInputBackgroundImageKey: img]).cropped(to: frameRectAll) }
// 横向（上下方向）的柔边带子：中心在 y（左上原点），半宽 hw，颜色 c、强度 a
func band(y: Double, hw: Double, _ c: CIColor, _ a: Double) -> CIImage {
  let yc = H - y
  let g = CIFilter(name: "CILinearGradient", parameters: ["inputPoint0": CIVector(x: 0, y: yc), "inputPoint1": CIVector(x: 0, y: yc + hw), "inputColor0": CIColor(red: c.red * a, green: c.green * a, blue: c.blue * a), "inputColor1": CIColor.black])!.outputImage!
  let g2 = CIFilter(name: "CILinearGradient", parameters: ["inputPoint0": CIVector(x: 0, y: yc), "inputPoint1": CIVector(x: 0, y: yc - hw), "inputColor0": CIColor.white, "inputColor1": CIColor.black])!.outputImage!
  return g.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: g2]).cropped(to: frameRectAll)
}
// 竖向的柔边光墙：中心在 x，半宽 hw
func wall(x: Double, hw: Double, _ c: CIColor, _ a: Double) -> CIImage {
  let g = CIFilter(name: "CILinearGradient", parameters: ["inputPoint0": CIVector(x: x, y: 0), "inputPoint1": CIVector(x: x + hw, y: 0), "inputColor0": CIColor(red: c.red * a, green: c.green * a, blue: c.blue * a), "inputColor1": CIColor.black])!.outputImage!
  let g2 = CIFilter(name: "CILinearGradient", parameters: ["inputPoint0": CIVector(x: x, y: 0), "inputPoint1": CIVector(x: x - hw, y: 0), "inputColor0": CIColor.white, "inputColor1": CIColor.black])!.outputImage!
  return g.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: g2]).cropped(to: frameRectAll)
}
func tailImg(_ t: [CVPixelBuffer], _ k: Int) -> CIImage? { t.isEmpty ? nil : CIImage(cvPixelBuffer: t[min(k, t.count - 1)]) }

// 换装转场：k 是这一刀开头的第几帧，n 是转场长度；incoming 是新造型这一帧，prevTail 是旧造型切点之后的帧
func transition(_ type: String, k: Int, n: Int, incoming: CIImage, prevTail: [CVPixelBuffer], ghosts: [CIImage], dir: Double) -> CIImage {
  guard k < n else { return incoming }
  let t = Double(k + 1) / Double(n + 1) // 0→1
  switch type {
  case "dissolve":
    guard let old = tailImg(prevTail, k) else { return incoming }
    return old.applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: incoming, kCIInputTimeKey: t])
      .applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: 14, kCIInputIntensityKey: sin(Double.pi * t) * 0.45]).cropped(to: frameRectAll)
  case "scan":
    // 扫描换装：一道主题色光带从上往下扫，光带上面已经是新造型，下面还是旧的
    guard let old = tailImg(prevTail, k) else { return incoming }
    let e = smooth01(t)
    let y = -0.08 * H + e * 1.16 * H, f = H * 0.02
    let mask = CIFilter(name: "CILinearGradient", parameters: ["inputPoint0": CIVector(x: 0, y: H - y + f), "inputPoint1": CIVector(x: 0, y: H - y - f), "inputColor0": CIColor.white, "inputColor1": CIColor.black])!.outputImage!.cropped(to: frameRectAll)
    let o = incoming.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: old, kCIInputMaskImageKey: mask]).cropped(to: frameRectAll)
    // 只让光带本身发光（整帧加柔光会把亮背景的舞台冲白）
    let glow = band(y: y, hw: H * 0.07, C2, 0.5).applyingGaussianBlur(sigma: 18).cropped(to: frameRectAll)
    return additive(additive(o, glow), band(y: y, hw: H * 0.018, C1, 0.9))
  case "stripes":
    // 赛道条纹换装：三道斜条纹（主题色描边）错开一点时间从左往右推过去，条纹推过的地方已经是新造型
    guard let old = tailImg(prevTail, k) else { return incoming }
    let shear = CGAffineTransform(a: 1, b: 0, c: -0.36, d: 1, tx: 0, ty: 0) // 往右上斜
    var mask = CIImage(color: .black).cropped(to: frameRectAll)
    var edges = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: frameRectAll)
    let bandH = H / 3
    for b in 0..<3 {
      let p = smooth01((t - Double(b) * 0.12) / 0.76)
      let x1 = -W * 0.4 + p * W * 1.8
      let y0 = Double(2 - b) * bandH // Core Image 原点在左下：第 0 道在最上面
      let r = CGRect(x: -W * 0.4, y: y0, width: max(0, x1 + W * 0.4), height: bandH + 1)
      let pivot = CGAffineTransform(translationX: 0, y: -(y0 + bandH / 2)).concatenating(shear).concatenating(CGAffineTransform(translationX: 0, y: y0 + bandH / 2))
      mask = CIImage(color: .white).cropped(to: r).transformed(by: pivot).composited(over: mask)
      if p > 0.01 && p < 0.99 {
        let e = CGRect(x: x1 - W * 0.012, y: y0, width: W * 0.012, height: bandH + 1)
        edges = CIImage(color: b == 1 ? C1 : C2).cropped(to: e).transformed(by: pivot).composited(over: edges)
      }
    }
    mask = mask.cropped(to: frameRectAll)
    let o = incoming.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: old, kCIInputMaskImageKey: mask]).cropped(to: frameRectAll)
    return edges.cropped(to: frameRectAll).composited(over: additive(o, edges.applyingGaussianBlur(sigma: 14).cropped(to: frameRectAll)))
  case "echo":
    // 残影换装：旧造型的人像染上主题色，作为两层半透明残影跟着跳，逐渐淡掉
    var o = incoming
    let fade = 1 - t
    // 残影拖在他动作方向的后面，越往后越淡、越偏
    for (n, (lag, a)) in [(0, 0.42), (3, 0.22)].enumerated() {
      let gi = k - lag
      guard gi >= 0, gi < ghosts.count else { continue }
      let off = -dir * W * 0.03 * Double(n + 1) * t
      let g = ghosts[gi].transformed(by: CGAffineTransform(translationX: off, y: 0))
        .applyingFilter("CIColorMonochrome", parameters: [kCIInputColorKey: n == 0 ? C1 : C2, kCIInputIntensityKey: 0.6])
        .applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: a * fade)])
      o = g.composited(over: o)
    }
    return o.cropped(to: frameRectAll)
  case "gate":
    // 节拍光门：主题色光墙从一侧推过来，光最亮的那一帧换场次
    // 光只在中间一两帧最亮，前后很快退掉，不要整段发白
    let peak = pow(sin(Double.pi * t), 3)
    let base = (t < 0.5 ? tailImg(prevTail, k) : nil) ?? incoming
    let x = dir > 0 ? (-0.3 + 1.6 * t) * W : (1.3 - 1.6 * t) * W
    var o = base.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: peak * 0.9])
    let w = wall(x: x, hw: W * 0.22, C1, 0.75 * sin(Double.pi * t)).applyingGaussianBlur(sigma: 24).cropped(to: frameRectAll)
    o = additive(o, w)
    o = additive(o, solid(C2, 0.08 * peak))
    return o
  case "whip":
    // 动势甩切：前半段旧画面顺着他的动作方向甩出去，后半段新画面从另一侧甩进来
    let first = t < 0.5
    let e = first ? smooth01(t * 2) : smooth01((1 - t) * 2)
    let src = (first ? tailImg(prevTail, k) : nil) ?? incoming
    let shift = dir * W * 0.18 * e * (first ? 1 : -1)
    return src.clampedToExtent().transformed(by: CGAffineTransform(translationX: shift, y: 0))
      .applyingFilter("CIMotionBlur", parameters: [kCIInputRadiusKey: 70 * e, kCIInputAngleKey: 0]).cropped(to: frameRectAll)
  case "pulse":
    // 色彩脉冲：硬切，新画面开头闪一下主题色（放大回弹在外面做）
    let e = pow(1 - Double(k) / Double(n), 2)
    return additive(incoming, solid(C2, 0.45 * e))
  default:
    return incoming
  }
}
// 全程锁定时把位置、大小接力下去：上一刀最后一帧他在成片里实际在哪、多大，新一刀开头就先放到同一个地方、同样大小，
// 再在约 1 秒里慢慢回到统一的位置和大小（上一刀如果因为原画不够没能放到正中，新一刀也不会突然跳到正中）
var carry: (x: Double, y: Double, s: Double)? = nil // 脖子在成片里的位置、身体大小（躯干像素）
var carryKP: [CGPoint?] = [] // 上一刀最后一帧 8 个点在成片里的位置（精细对齐用）
var prevTailKP: [[CGPoint?]] = [] // 上一刀切点之后几帧的 8 个点（人形变形过渡用）
// 相似变换拟合：把素材里的点 p 变到成片里的点 q（缩放 + 旋转 + 平移，最小二乘）
func fitSimilarity(_ p: [CGPoint?], _ q: [CGPoint?]) -> (s: Double, ang: Double, pc: CGPoint, qc: CGPoint)? {
  let pairs = zip(p, q).compactMap { a, b in (a != nil && b != nil) ? (a!, b!) : nil }
  guard pairs.count >= 3 else { return nil }
  let n = Double(pairs.count)
  let pc = CGPoint(x: pairs.map { $0.0.x }.reduce(0, +) / n, y: pairs.map { $0.0.y }.reduce(0, +) / n)
  let qc = CGPoint(x: pairs.map { $0.1.x }.reduce(0, +) / n, y: pairs.map { $0.1.y }.reduce(0, +) / n)
  var a = 0.0, b = 0.0, c = 0.0
  for (u, v) in pairs {
    let px = u.x - pc.x, py = u.y - pc.y, qx = v.x - qc.x, qy = v.y - qc.y
    a += px * qx + py * qy; b += px * qy - py * qx; c += px * px + py * py
  }
  guard c > 1 else { return nil }
  return (hypot(a, b) / c, atan2(b, a), pc, qc)
}
// 人形变形过渡：旧画面、新画面各自按对应点往中间位置扭一点，再按 t 混合（只在 CPU 上算这几帧）
func morphBlend(old: CVPixelBuffer, new newImg: CIImage, kOld: [CGPoint?], kNew: [CGPoint?], t: Double) -> CIImage? {
  let pts = zip(kOld, kNew).compactMap { a, b in (a != nil && b != nil) ? (a!, b!) : nil }
  guard pts.count >= 3 else { return nil }
  let w = Int(W), h = Int(H)
  var nb: CVPixelBuffer?
  CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &nb)
  var ob: CVPixelBuffer?
  CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &ob)
  guard let nbuf = nb, let obuf = ob else { return nil }
  ctx.render(newImg, to: nbuf, bounds: CGRect(x: 0, y: 0, width: W, height: H), colorSpace: rgb)
  let mids = pts.map { (CGPoint(x: $0.0.x + ($0.1.x - $0.0.x) * t, y: $0.0.y + ($0.1.y - $0.0.y) * t), $0.0, $0.1) }
  let sig2 = pow(H * 0.12, 2) * 2
  CVPixelBufferLockBaseAddress(old, .readOnly); CVPixelBufferLockBaseAddress(nbuf, .readOnly); CVPixelBufferLockBaseAddress(obuf, [])
  defer { CVPixelBufferUnlockBaseAddress(old, .readOnly); CVPixelBufferUnlockBaseAddress(nbuf, .readOnly); CVPixelBufferUnlockBaseAddress(obuf, []) }
  let rbO = CVPixelBufferGetBytesPerRow(old), rbN = CVPixelBufferGetBytesPerRow(nbuf), rbX = CVPixelBufferGetBytesPerRow(obuf)
  let pO = CVPixelBufferGetBaseAddress(old)!.assumingMemoryBound(to: UInt8.self)
  let pN = CVPixelBufferGetBaseAddress(nbuf)!.assumingMemoryBound(to: UInt8.self)
  let pX = CVPixelBufferGetBaseAddress(obuf)!.assumingMemoryBound(to: UInt8.self)
  // 位移场先在粗网格上算（每 8 像素一个点），再双线性插值
  let gs = 8, gw = w / gs + 2, gh = h / gs + 2
  var dO = [Float](repeating: 0, count: gw * gh * 2), dN = [Float](repeating: 0, count: gw * gh * 2)
  for gy in 0..<gh { for gx in 0..<gw {
    let x = Double(gx * gs), y = Double(gy * gs)
    var sw = 0.15, ox = 0.0, oy = 0.0, nx = 0.0, ny = 0.0
    for (m, a, b) in mids {
      let wt = exp(-(pow(x - m.x, 2) + pow(y - m.y, 2)) / sig2)
      sw += wt; ox += wt * (a.x - m.x); oy += wt * (a.y - m.y); nx += wt * (b.x - m.x); ny += wt * (b.y - m.y)
    }
    let i = (gy * gw + gx) * 2
    dO[i] = Float(ox / sw); dO[i + 1] = Float(oy / sw); dN[i] = Float(nx / sw); dN[i + 1] = Float(ny / sw)
  } }
  @inline(__always) func sample(_ p: UnsafeMutablePointer<UInt8>, _ rb: Int, _ x: Float, _ y: Float, _ c: Int) -> Float {
    let xc = min(Float(w - 2), max(0, x)), yc = min(Float(h - 2), max(0, y))
    let x0 = Int(xc), y0 = Int(yc), fx = xc - Float(x0), fy = yc - Float(y0)
    let a = Float(p[y0 * rb + x0 * 4 + c]), b = Float(p[y0 * rb + (x0 + 1) * 4 + c])
    let c2 = Float(p[(y0 + 1) * rb + x0 * 4 + c]), d = Float(p[(y0 + 1) * rb + (x0 + 1) * 4 + c])
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c2 * (1 - fx) + d * fx) * fy
  }
  let tf = Float(t)
  for y in 0..<h {
    let gyf = Float(y) / Float(gs), gy0 = Int(gyf), fy = gyf - Float(gy0)
    for x in 0..<w {
      let gxf = Float(x) / Float(gs), gx0 = Int(gxf), fx = gxf - Float(gx0)
      let i00 = (gy0 * gw + gx0) * 2, i10 = i00 + 2, i01 = i00 + gw * 2, i11 = i01 + 2
      func lerp2(_ d: [Float], _ o: Int) -> Float { (d[i00 + o] * (1 - fx) + d[i10 + o] * fx) * (1 - fy) + (d[i01 + o] * (1 - fx) + d[i11 + o] * fx) * fy }
      let oxs = Float(x) + lerp2(dO, 0), oys = Float(y) + lerp2(dO, 1)
      let nxs = Float(x) + lerp2(dN, 0), nys = Float(y) + lerp2(dN, 1)
      for c in 0..<4 {
        let v = sample(pO, rbO, oxs, oys, c) * (1 - tf) + sample(pN, rbN, nxs, nys, c) * tf
        pX[y * rbX + x * 4 + c] = UInt8(max(0, min(255, v)))
      }
    }
  }
  return CIImage(cvPixelBuffer: obuf)
}
let carryFrames = max(1.0, job.fps * 1.0)
let cutMode = job.mode == "cut"
let E = max(1.0, (job.ease ?? 0.5) * job.fps)
func smooth01(_ x: Double) -> Double { let t = min(1, max(0, x)); return t * t * (3 - 2 * t) }
for (si, seg) in job.segments.enumerated() {
  let total = seg.frames + tailOf(si)
  let dur = Double(total) / job.fps
  let p = plans[si]
  let base = p.pre + nudge[si]
  let sw = p.sw, sh = p.sh
  let neckX = p.neckX, neckY = p.neckY, boxes = p.boxes
  let s0 = max(W / sw, H / sh)
  var z = p.torso > 0 ? targetTorso / (p.torso * s0) : 1.15
  z = min(job.zoomMax, max(job.zoomMin, z))
  let S = s0 * z
  report.append(["i": si, "found": p.found, "frames": seg.frames, "zoom": (z * 100).rounded() / 100, "nudge": nudge[si]])
  let gain = seg.array == true ? nil : gains[seg.file] // 分身阵列已经在合成时按各自场次调过色

  // 第二遍：渲染
  let st2 = seg.start + Double(nudge[si]) / job.fps
  let src2 = FrameSource(file: seg.file, start: st2, dur: dur)
  var myTail: [CVPixelBuffer] = []
  var myGhost: [CIImage] = []
  let strong = seg.strong ?? false
  let fx = si == 0 ? (type: "cut", frames: 0) : fxOf(si)
  let useFlash = fx.type == "flash"
  let nextEcho = si < job.segments.count - 1 && fxOf(si + 1).type == "echo"
  // 甩切方向：上一刀结尾他往哪边动，就往哪边甩（看不出来就左右交替）
  var whipDir = si % 2 == 0 ? 1.0 : -1.0
  if si > 0 {
    let a = plans[si - 1], e = a.pre + nudge[si - 1] + job.segments[si - 1].frames - 1
    if e - 6 >= 0, e < a.neckX.count { let dx = a.neckX[e] - a.neckX[e - 6]; if abs(dx) > a.sw * 0.01 { whipDir = dx > 0 ? 1 : -1 } }
  }
  var myTailKP: [[CGPoint?]] = []
  // 这一刀开头的 8 个点 → 上一刀结尾的 8 个点（成片坐标），拟合一次
  var fineFit: (s: Double, ang: Double, pc: CGPoint, qc: CGPoint)? = nil
  if si > 0, !carryKP.isEmpty, job.mode != "cut", seg.free != true {
    let j0 = min(p.kps.count - 1, max(0, base))
    if let k0 = (0...3).lazy.compactMap({ d -> [CGPoint?]? in p.kps[min(p.kps.count - 1, j0 + d)] }).first { fineFit = fitSimilarity(k0, carryKP) }
  }
  for k in 0..<total {
    guard let buf = src2.frame(at: st2 + Double(k) / job.fps) else { continue }
    let j = min(neckX.count - 1, max(0, base + k))
    // 裁切框：让脖子落在目标位置，框不出原画
    var S = S
    var ang = 0.0 // 旋转（弧度），精细对齐时才有
    var x0 = neckX[j] * S - job.target.x * W, y0 = neckY[j] * S - job.target.y * H
    // 精细对齐：新一刀开头用 8 个点（脖子、肩、胯、鼻子、眼睛）拟合位置、大小、倾斜，和上一刀结尾重合，再约 1 秒回到标准位置
    let kpHere: [CGPoint?]? = (0...2).lazy.compactMap { d -> [CGPoint?]? in let jj = min(p.kps.count - 1, j + d); return p.kps[jj] }.first
    if !cutMode, si > 0, k < Int(carryFrames), !carryKP.isEmpty, let kp0 = fineFit, let kh = kpHere, kh[0] != nil {
      let w = smooth01(1 - Double(k) / carryFrames)
      S = min(s0 * job.zoomMax, max(s0 * job.zoomMin * 0.9, S + (kp0.s - S) * w))
      ang = max(-0.08, min(0.08, kp0.ang)) * w
      // 这一帧他的脖子按拟合变换会落在哪，和标准位置之间按 w 插值
      let nx = neckX[j] - kp0.pc.x, ny = neckY[j] - kp0.pc.y
      let fxp = kp0.qc.x + kp0.s * (cos(kp0.ang) * nx - sin(kp0.ang) * ny), fyp = kp0.qc.y + kp0.s * (sin(kp0.ang) * nx + cos(kp0.ang) * ny)
      let wantX = job.target.x * W + (fxp - job.target.x * W) * w, wantY = job.target.y * H + (fyp - job.target.y * H) * w
      x0 = neckX[j] * S - wantX; y0 = neckY[j] * S - wantY
    } else if !cutMode, seg.free != true, let c = carry, si > 0, p.torso > 0 {
      let w = smooth01(1 - Double(k) / carryFrames)
      let Sc = c.s / p.torso // 让他和上一刀结尾一样大
      S = min(s0 * job.zoomMax, max(s0 * job.zoomMin, S + (Sc - S) * w))
      let wantX = job.target.x * W + (c.x - job.target.x * W) * w, wantY = job.target.y * H + (c.y - job.target.y * H) * w
      x0 = neckX[j] * S - wantX; y0 = neckY[j] * S - wantY
    }
    if cutMode {
      // 只在换装瞬间对齐：开头 E 帧从对齐过渡到原机位，结尾 E 帧从原机位过渡到对齐；第一刀开头、最后一刀结尾不对齐
      let wIn = si == 0 ? 0 : smooth01(1 - Double(k) / E)
      let wOut = si == job.segments.count - 1 ? 0 : (k >= seg.frames ? 1 : smooth01(1 - Double(seg.frames - 1 - k) / E))
      let w = max(wIn, wOut)
      let Sn = s0, Sa = s0 * z
      S = Sn + (Sa - Sn) * w
      // 原机位下脖子在成片里的位置 -> 目标位置，按 w 插值，再反推裁切框
      let natX = neckX[j] * Sn - (sw * Sn - W) / 2, natY = neckY[j] * Sn - (sh * Sn - H) / 2
      let wantX = natX + (job.target.x * W - natX) * w, wantY = natY + (job.target.y * H - natY) * w
      x0 = neckX[j] * S - wantX; y0 = neckY[j] * S - wantY
    }
    // 舞台模式：不锁定，原机位画面（不放大、不挪）
    if seg.free == true { S = s0; ang = 0; x0 = (sw * S - W) / 2; y0 = (sh * S - H) / 2 }
    // 认不到他时交还原机位：同样的放大倍数，裁切框回到原画中间
    if !cutMode, seg.free != true, j < p.lost.count, p.lost[j] > 0 {
      let w = p.lost[j]
      x0 += ((sw * S - W) / 2 - x0) * w; y0 += ((sh * S - H) / 2 - y0) * w
    }
    // 有背景虚化时，裁切框可以超出原画（最多画面的 30%），超出的部分用虚化后的边缘补上，主角照样钉在原位；
    // 没有背景虚化就只能在原画范围里移动
    let over = job.background != nil ? 0.3 : 0.0
    x0 = min(max(-W * over, x0), sw * S - W + W * over); y0 = min(max(-H * over, y0), sh * S - H + H * over)
    // 记下这一刀结尾（切点前最后一帧）他实际在哪、多大，给下一刀接力
    if k == seg.frames - 1 { carry = seg.free == true || p.torso <= 0 ? nil : (neckX[j] * S - x0, neckY[j] * S - y0, p.torso * S) } // 舞台模式段之后不接力位置
    // 这一帧 8 个点在成片里的位置（缩放平移后再绕脖子转 ang）
    let pivX = neckX[j] * S - x0, pivY = neckY[j] * S - y0
    let kpOut: [CGPoint?] = (kpHere ?? []).map { q in q.map { pt in
      let ux = pt.x * S - x0 - pivX, uy = pt.y * S - y0 - pivY
      return CGPoint(x: pivX + cos(ang) * ux - sin(ang) * uy, y: pivY + sin(ang) * ux + cos(ang) * uy) } }
    if k == seg.frames - 1 { carryKP = seg.free == true ? [] : kpOut }
    if k >= seg.frames { myTailKP.append(kpOut) }
    // 切点放大回弹
    var punch = 1.0, ev = 0.0
    if fx.type == "pulse", k < fx.frames {
      punch = 1 + 0.05 * pow(1 - Double(k) / Double(fx.frames), 2)
    }
    if let fl = job.flash, useFlash, k < fl.frames {
      let e = pow(1 - Double(k) / Double(fl.frames), 2)
      ev = (strong ? fl.strong : fl.light) * e
      punch = 1 + (strong ? fl.punch : fl.punch * 0.4) * e
    }
    // Core Image 原点在左下：先把素材坐标翻成左上原点再缩放、平移
    var img = CIImage(cvPixelBuffer: buf)
    if let g = gain {
      img = img.applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: g[0], y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: g[1], z: 0, w: 0), "inputBVector": CIVector(x: 0, y: 0, z: g[2], w: 0)])
    }
    func place(_ i: CIImage) -> CIImage {
      var t = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -sh) // 翻成左上原点
      t = t.concatenating(CGAffineTransform(scaleX: S, y: S)).concatenating(CGAffineTransform(translationX: -x0, y: -y0))
      if ang != 0 { t = t.concatenating(CGAffineTransform(translationX: -pivX, y: -pivY)).concatenating(CGAffineTransform(rotationAngle: ang)).concatenating(CGAffineTransform(translationX: pivX, y: pivY)) }
      // 放大回弹以目标位置为中心
      let cx = job.target.x * W, cy = job.target.y * H
      t = t.concatenating(CGAffineTransform(translationX: -cx, y: -cy)).concatenating(CGAffineTransform(scaleX: punch, y: punch)).concatenating(CGAffineTransform(translationX: cx, y: cy))
      return i.transformed(by: t).transformed(by: CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -H)) // 翻回左下原点
    }
    let frameRect = CGRect(x: 0, y: 0, width: W, height: H)
    // 有旋转时，转出去露出的角用原画边缘像素补（角度小，只有几像素）
    var out = place(ang != 0 ? img.clampedToExtent() : img).cropped(to: frameRect)
    var maskImg: CIImage? = nil
    if job.background != nil {
      try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([segReq])
      if let m = segReq.results?.first?.pixelBuffer { let mi = CIImage(cvPixelBuffer: m); maskImg = mi.transformed(by: CGAffineTransform(scaleX: sw / mi.extent.width, y: sh / mi.extent.height)) }
    }
    if let bg = job.background, let m = maskImg {
      // 主角遮罩 = 人像分割 ∩ 他身体周围的区域（羽化），周围的人在这个区域外就被当背景
      let b = boxes[j] ?? CGRect(x: neckX[j] - sw * 0.12, y: neckY[j] - sh * 0.1, width: sw * 0.24, height: sh * 0.8)
      let pad = b.insetBy(dx: -max(b.width * 0.35, sw * 0.04), dy: -max(b.height * 0.12, sh * 0.04))
      let region = CIImage(color: .white).cropped(to: CGRect(x: pad.minX, y: sh - pad.maxY, width: pad.width, height: pad.height))
        .composited(over: CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh)))
        .applyingGaussianBlur(sigma: sw * 0.02).cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh))
      var mask = m.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: region])
      for kr in seg.keep ?? [] where kr.count == 4 {
        let rr = CGRect(x: kr[0] * sw, y: (1 - kr[1] - kr[3]) * sh, width: kr[2] * sw, height: kr[3] * sh)
        mask = CIImage(color: .white).cropped(to: rr).composited(over: mask)
      }
      mask = mask.applyingGaussianBlur(sigma: 3).cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh))
      let blurred = img.clampedToExtent().applyingGaussianBlur(sigma: max(bg.blur, 24)).cropped(to: img.extent.insetBy(dx: -sw * 0.5, dy: -sh * 0.5))
        .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1 - bg.desat, kCIInputBrightnessKey: 0, kCIInputContrastKey: 1])
        .applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: bg.dim, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: bg.dim, z: 0, w: 0), "inputBVector": CIVector(x: 0, y: 0, z: bg.dim, w: 0)])
      let comp = img.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: blurred, kCIInputMaskImageKey: mask.clampedToExtent().cropped(to: img.extent).composited(over: CIImage(color: .black).cropped(to: blurred.extent))])
      out = place(comp).cropped(to: frameRect)
    }
    if ev > 0.01 {
      out = out.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: ev])
        .applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: 12, kCIInputIntensityKey: min(1, ev * 0.6)]).cropped(to: frameRect)
    }
    // 切点之后的 tail 帧：不写进成片，留给下一刀开头叠化
    if k >= seg.frames {
      var tb: CVPixelBuffer?
      CVPixelBufferCreate(nil, Int(W), Int(H), kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &tb)
      if let tb = tb { ctx.render(out, to: tb, bounds: frameRect, colorSpace: rgb); myTail.append(tb) }
      // 残影换装：把旧造型的人像抠出来留着（人像分割 ∩ 他身体周围），下一刀开头叠上去
      if nextEcho {
        try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([segReq])
        if let m = segReq.results?.first?.pixelBuffer {
          let mi = CIImage(cvPixelBuffer: m); let mm = mi.transformed(by: CGAffineTransform(scaleX: sw / mi.extent.width, y: sh / mi.extent.height))
          let b = boxes[j] ?? CGRect(x: neckX[j] - sw * 0.12, y: neckY[j] - sh * 0.1, width: sw * 0.24, height: sh * 0.8)
          let pad = b.insetBy(dx: -b.width * 0.25, dy: -b.height * 0.08)
          let region = CIImage(color: .white).cropped(to: CGRect(x: pad.minX, y: sh - pad.maxY, width: pad.width, height: pad.height))
            .composited(over: CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh))).applyingGaussianBlur(sigma: sw * 0.015)
          let mask = mm.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: region]).cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh))
          let ghost = img.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: img.extent), kCIInputMaskImageKey: mask])
          let rendered = ctx.createCGImage(place(ghost).cropped(to: frameRect), from: frameRect).map { CIImage(cgImage: $0) }
          myGhost.append(rendered ?? CIImage(color: .clear).cropped(to: frameRect))
        }
      }
      continue
    }
    if fx.type == "morph", k < fx.frames, k < prevTail.count, k < prevTailKP.count {
      let t = smooth01(Double(k + 1) / Double(fx.frames + 1))
      out = morphBlend(old: prevTail[k], new: out, kOld: prevTailKP[k], kNew: kpOut, t: t) ?? transition("dissolve", k: k, n: fx.frames, incoming: out, prevTail: prevTail, ghosts: prevGhost, dir: whipDir)
    } else {
      out = transition(fx.type, k: k, n: fx.frames, incoming: out, prevTail: prevTail, ghosts: prevGhost, dir: whipDir)
    }
    while !vin.isReadyForMoreMediaData { usleep(2000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    guard let pbuf = pb else { fail("申请输出帧失败") }
    ctx.render(out, to: pbuf, bounds: frameRect, colorSpace: rgb)
    adaptor.append(pbuf, withPresentationTime: CMTime(value: outIndex, timescale: CMTimeScale(job.fps)))
    outIndex += 1
  }
  prevTail = myTail
  prevTailKP = myTailKP
  prevGhost = myGhost
  FileHandle.standardError.write("\r片段 \(si + 1)/\(job.segments.count)".data(using: .utf8)!)
}
vin.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("写视频失败：\(writer.error?.localizedDescription ?? "未知")") }
let data = try! JSONSerialization.data(withJSONObject: ["frames": outIndex, "segments": report])
FileHandle.standardOutput.write(data)
