// 原地换装渲染：逐帧找主角的骨架，把他钉在画面同一个位置、同样大小；背景和周围的人虚化压暗；切点加闪白和放大回弹。
// 只用 macOS 自带的 Vision（人体姿态、人像分割）和 Core Image，不做人脸识别。montage.mjs 的 render 在 spec 里有 "lock" 时调用它。
//   lockfx <job.json>
// job: { size:[W,H], fps, out, target:{x,y,torso}, zoomMin, zoomMax, smooth, background:{blur,dim,desat}|null,
//        flash:{light,strong,frames,punch}, transition:{type:dissolve|flash|mix,frames}, segments:[{file,start,frames,hint:{cx,cy}|null,strong,keep:[[x,y,w,h]]}] }
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
  struct Segment: Decodable { let file: String; let start: Double; let frames: Int; let hint: Hint?; let track: [[Double]]?; let strong: Bool?; let keep: [[Double]]? }
  let size: [Int]; let fps: Double; let out: String
  let target: Target; let zoomMin: Double; let zoomMax: Double; let smooth: Double
  let background: Background?; let flash: Flash?; let transition: Transition?; let segments: [Segment]
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
struct Body { var neck: CGPoint; var torso: Double; var box: CGRect } // 素材像素坐标，原点左上
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
    return torso > 8 ? Body(neck: neck, torso: torso, box: box) : nil
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
// 渐变要用到上一刀切点之后的几帧：每一刀（最后一刀除外）多分析、多渲染 tail 帧，和下一刀开头叠化
let tail = (tType == "dissolve" || tType == "mix") ? max(2, job.transition?.frames ?? 6) : 0
func tailOf(_ si: Int) -> Int { si < job.segments.count - 1 ? tail : 0 }

struct Plan { var neckX: [Double]; var neckY: [Double]; var boxes: [CGRect?]; var torso: Double; var found: Int; var sw: Double; var sh: Double }
var plans: [Plan] = []
// 第一遍：每一刀逐帧找主角
for (si, seg) in job.segments.enumerated() {
  let total = seg.frames + tailOf(si)
  let dur = Double(total) / job.fps
  let src = FrameSource(file: seg.file, start: seg.start, dur: dur)
  let sw = Double(src.size.width), sh = Double(src.size.height)
  var picked: [Body?] = []
  var prev: Body? = nil
  for k in 0..<total {
    guard let buf = src.frame(at: seg.start + Double(k) / job.fps) else { picked.append(nil); continue }
    let h = VNImageRequestHandler(cvPixelBuffer: buf, options: [:])
    try? h.perform([poseReq])
    let cands = bodies(poseReq.results ?? [], sw, sh)
    // 认人：附近 0.3 秒内有认人框时，只认脖子落在框里的那个人（框的上半部分），离框顶中间最近的；
    // 没有框就和上一帧连贯；第一帧还没有参照，就用画面中间偏大的人
    let tsec = Double(k) / job.fps
    let tb = (seg.track ?? []).filter { $0.count == 5 && abs($0[0] - tsec) <= 0.3 }.min { abs($0[0] - tsec) < abs($1[0] - tsec) }
    var best: Body? = nil
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
  // 平滑：前后各 smooth/2 秒的移动平均，去掉骨架识别的抖动
  let r = max(1, Int(job.smooth * job.fps / 2))
  func smoothed(_ v: [Double]) -> [Double] { v.indices.map { i in let lo = max(0, i - r), hi = min(v.count - 1, i + r); return v[lo...hi].reduce(0, +) / Double(hi - lo + 1) } }
  // 这一刀的身体大小取偏大的读数（第 75 百分位），弯腰、转身那几帧量小了不算
  let ts = known.map { $0.1.torso }.sorted()
  plans.append(Plan(neckX: smoothed(neckX), neckY: smoothed(neckY), boxes: boxes, torso: ts.isEmpty ? 0 : ts[min(ts.count - 1, Int(Double(ts.count) * 0.75))], found: known.count, sw: sw, sh: sh))
  FileHandle.standardError.write("\r分析 \(si + 1)/\(job.segments.count)".data(using: .utf8)!)
}
// 统一大小：每一刀不放大时主角躯干在成片里多长；目标取偏大的那头（第 85 百分位 × 最小放大），大的少放大，小的多放大
let natural = plans.map { p in p.torso * max(W / p.sw, H / p.sh) }.filter { $0 > 0 }
let targetTorso = job.target.torso.map { $0 * H } ?? ((natural.sorted().dropFirst(Int(Double(natural.count) * 0.85)).first ?? natural.max() ?? H * 0.3) * job.zoomMin)

var prevTail: [CVPixelBuffer] = []
for (si, seg) in job.segments.enumerated() {
  let total = seg.frames + tailOf(si)
  let dur = Double(total) / job.fps
  let p = plans[si]
  let sw = p.sw, sh = p.sh
  let neckX = p.neckX, neckY = p.neckY, boxes = p.boxes
  let s0 = max(W / sw, H / sh)
  var z = p.torso > 0 ? targetTorso / (p.torso * s0) : 1.15
  z = min(job.zoomMax, max(job.zoomMin, z))
  let S = s0 * z
  report.append(["i": si, "found": p.found, "frames": seg.frames, "zoom": (z * 100).rounded() / 100])

  // 第二遍：渲染
  let src2 = FrameSource(file: seg.file, start: seg.start, dur: dur)
  var myTail: [CVPixelBuffer] = []
  let strong = seg.strong ?? false
  let useFlash = tType == "flash" || (tType == "mix" && strong)
  for k in 0..<total {
    guard let buf = src2.frame(at: seg.start + Double(k) / job.fps) else { continue }
    // 裁切框：让脖子落在目标位置，框不出原画
    var x0 = neckX[k] * S - job.target.x * W, y0 = neckY[k] * S - job.target.y * H
    // 有背景虚化时，裁切框可以超出原画（最多画面的 30%），超出的部分用虚化后的边缘补上，主角照样钉在原位；
    // 没有背景虚化就只能在原画范围里移动
    let over = job.background != nil ? 0.3 : 0.0
    x0 = min(max(-W * over, x0), sw * S - W + W * over); y0 = min(max(-H * over, y0), sh * S - H + H * over)
    // 切点放大回弹
    var punch = 1.0, ev = 0.0
    if let fl = job.flash, useFlash, k < fl.frames {
      let e = pow(1 - Double(k) / Double(fl.frames), 2)
      ev = (strong ? fl.strong : fl.light) * e
      punch = 1 + (strong ? fl.punch : fl.punch * 0.4) * e
    }
    // Core Image 原点在左下：先把素材坐标翻成左上原点再缩放、平移
    let img = CIImage(cvPixelBuffer: buf)
    func place(_ i: CIImage) -> CIImage {
      var t = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -sh) // 翻成左上原点
      t = t.concatenating(CGAffineTransform(scaleX: S, y: S)).concatenating(CGAffineTransform(translationX: -x0, y: -y0))
      // 放大回弹以目标位置为中心
      let cx = job.target.x * W, cy = job.target.y * H
      t = t.concatenating(CGAffineTransform(translationX: -cx, y: -cy)).concatenating(CGAffineTransform(scaleX: punch, y: punch)).concatenating(CGAffineTransform(translationX: cx, y: cy))
      return i.transformed(by: t).transformed(by: CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -H)) // 翻回左下原点
    }
    let frameRect = CGRect(x: 0, y: 0, width: W, height: H)
    var out = place(img.transformed(by: .identity)).cropped(to: frameRect)
    var maskImg: CIImage? = nil
    if job.background != nil {
      try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([segReq])
      if let m = segReq.results?.first?.pixelBuffer { let mi = CIImage(cvPixelBuffer: m); maskImg = mi.transformed(by: CGAffineTransform(scaleX: sw / mi.extent.width, y: sh / mi.extent.height)) }
    }
    if let bg = job.background, let m = maskImg {
      // 主角遮罩 = 人像分割 ∩ 他身体周围的区域（羽化），周围的人在这个区域外就被当背景
      let b = boxes[k] ?? CGRect(x: neckX[k] - sw * 0.12, y: neckY[k] - sh * 0.1, width: sw * 0.24, height: sh * 0.8)
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
      continue
    }
    // 渐变：开头几帧从上一刀的 tail 叠化过来，中间加一点柔光
    if !useFlash, k < prevTail.count {
      let tm = Double(k + 1) / Double(prevTail.count + 1)
      out = CIImage(cvPixelBuffer: prevTail[k]).applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: out, kCIInputTimeKey: tm]).cropped(to: frameRect)
      let glow = sin(Double.pi * tm) * 0.45
      out = out.applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: 14, kCIInputIntensityKey: glow]).cropped(to: frameRect)
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
  FileHandle.standardError.write("\r片段 \(si + 1)/\(job.segments.count)".data(using: .utf8)!)
}
vin.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("写视频失败：\(writer.error?.localizedDescription ?? "未知")") }
let data = try! JSONSerialization.data(withJSONObject: ["frames": outIndex, "segments": report])
FileHandle.standardOutput.write(data)
