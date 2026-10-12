// 逐帧提取画面里每个人的全身骨架和外观（macOS Vision 人体姿态 + 通用图像特征，不做人脸识别），
// 由 montage.mjs 在整条片段上认出哪一个是主角（外观最像 + 前后帧连贯），给换装选场次、找动作最一致的接点、锁定画面用。
//   pose <job.json>
// job: { file, step, fpEvery }  fpEvery：每隔几帧算一次外观特征和脸部特征（贵），其余帧只算颜色
// 输出 JSON：{ samples: [ { t, c: [ { neck:[x,y], torso, joints:[[x,y]|null ×12], hair:[64], cloth:[64], fp?:[…] } ] } ] }
// joints 是肩、肘、腕、胯、膝、踝相对脖子、按身体大小归一后的位置；neck、torso 是 0–1 坐标和占画面高的比例
// hair：头顶一小块的色相分布（28 档）；cloth：上身的颜色分布（4×4×4 RGB），都加起来是 1
import AVFoundation
import Foundation
import Vision

struct Job: Decodable { let file: String; let step: Double; let fpEvery: Int? }
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
guard CommandLine.arguments.count >= 2, let d = FileManager.default.contents(atPath: CommandLine.arguments[1]),
      let job = try? JSONDecoder().decode(Job.self, from: d) else { fail("用法：pose <job.json>") }

let asset = AVURLAsset(url: URL(fileURLWithPath: job.file))
guard let track = asset.tracks(withMediaType: .video).first else { fail("没有视频轨") }
let size = track.naturalSize
let sw = Double(size.width), sh = Double(size.height)
let reader = try! AVAssetReader(asset: asset)
let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
out.alwaysCopiesSampleData = false
reader.add(out); reader.startReading()

let JOINTS: [VNHumanBodyPoseObservation.JointName] = [.leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist, .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle]
let req = VNDetectHumanBodyPoseRequest()
var samples: [[String: Any]] = []
var next = 0.0
var frameNo = 0
let fpEvery = max(1, job.fpEvery ?? 5)
let r3 = { (x: Double) in (x * 1000).rounded() / 1000 }

// 一块区域（0–1 坐标，原点左上）的 4×4×4 颜色分布，直接读像素
func hist(_ buf: CVPixelBuffer, _ r: CGRect) -> [Double] {
  let W = CVPixelBufferGetWidth(buf), H = CVPixelBufferGetHeight(buf)
  let box = CGRect(x: r.minX * Double(W), y: r.minY * Double(H), width: r.width * Double(W), height: r.height * Double(H)).intersection(CGRect(x: 0, y: 0, width: W, height: H)).integral
  guard box.width >= 4, box.height >= 4 else { return [] }
  CVPixelBufferLockBaseAddress(buf, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buf) else { return [] }
  let row = CVPixelBufferGetBytesPerRow(buf)
  let p = base.assumingMemoryBound(to: UInt8.self)
  var h = [Double](repeating: 0, count: 64)
  let n = 20
  for iy in 0..<n {
    for ix in 0..<n {
      let x = Int(box.minX) + Int(Double(ix) * box.width / Double(n)), y = Int(box.minY) + Int(Double(iy) * box.height / Double(n))
      let o = y * row + x * 4
      let b = Int(p[o]) >> 6, g = Int(p[o + 1]) >> 6, rr = Int(p[o + 2]) >> 6
      h[rr * 16 + g * 4 + b] += 1
    }
  }
  return h.map { r3($0 / Double(n * n)) }
}
// 头发用色相分布：12 个色相 × 2 档饱和度，再加 4 档灰度（低饱和）。粉、金、红、白在 RGB 粗分布里容易混，色相分得开
func hueHist(_ buf: CVPixelBuffer, _ r: CGRect) -> [Double] {
  let W = CVPixelBufferGetWidth(buf), H = CVPixelBufferGetHeight(buf)
  let box = CGRect(x: r.minX * Double(W), y: r.minY * Double(H), width: r.width * Double(W), height: r.height * Double(H)).intersection(CGRect(x: 0, y: 0, width: W, height: H)).integral
  guard box.width >= 4, box.height >= 4 else { return [] }
  CVPixelBufferLockBaseAddress(buf, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buf) else { return [] }
  let row = CVPixelBufferGetBytesPerRow(buf)
  let p = base.assumingMemoryBound(to: UInt8.self)
  var h = [Double](repeating: 0, count: 28)
  let n = 20
  for iy in 0..<n {
    for ix in 0..<n {
      let x = Int(box.minX) + Int(Double(ix) * box.width / Double(n)), y = Int(box.minY) + Int(Double(iy) * box.height / Double(n))
      let o = y * row + x * 4
      let b = Double(p[o]) / 255, g = Double(p[o + 1]) / 255, rr = Double(p[o + 2]) / 255
      let mx = max(rr, g, b), mn = min(rr, g, b), v = mx, s = mx > 0 ? (mx - mn) / mx : 0
      if s < 0.18 || v < 0.12 { h[24 + min(3, Int(v * 4))] += 1; continue }
      var hue = 0.0
      if mx == rr { hue = (g - b) / (mx - mn) } else if mx == g { hue = 2 + (b - rr) / (mx - mn) } else { hue = 4 + (rr - g) / (mx - mn) }
      hue = (hue / 6).truncatingRemainder(dividingBy: 1); if hue < 0 { hue += 1 }
      h[min(11, Int(hue * 12)) * 2 + (s < 0.45 ? 0 : 1)] += 1
    }
  }
  return h.map { r3($0 / Double(n * n)) }
}
func featurePrint(_ buf: CVPixelBuffer, _ r: CGRect) -> [Double] {
  let roi = r.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  guard roi.width * sw >= 16, roi.height * sh >= 16 else { return [] }
  let fr = VNGenerateImageFeaturePrintRequest()
  fr.imageCropAndScaleOption = .scaleFit
  fr.regionOfInterest = CGRect(x: roi.minX, y: 1 - roi.maxY, width: roi.width, height: roi.height) // Vision 原点在左下
  guard (try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([fr])) != nil, let obs = fr.results?.first else { return [] }
  let n = obs.elementCount
  var v = [Double](repeating: 0, count: n)
  obs.data.withUnsafeBytes { raw in
    if obs.elementType == .float { for i in 0..<n { v[i] = Double(raw.load(fromByteOffset: i * 4, as: Float.self)) } }
    else { for i in 0..<n { v[i] = raw.load(fromByteOffset: i * 8, as: Double.self) } }
  }
  let norm = sqrt(v.reduce(0) { $0 + $1 * $1 }) + 1e-9
  return v.map { r3($0 / norm) }
}

while let sb = out.copyNextSampleBuffer() {
  let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
  guard t + 1e-6 >= next, let buf = CMSampleBufferGetImageBuffer(sb) else { continue }
  next = t + job.step
  let withFp = frameNo % fpEvery == 0
  frameNo += 1
  try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([req])
  var cands: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let pts = try? o.recognizedPoints(.all) else { continue }
    func p(_ k: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
      guard let q = pts[k], q.confidence > 0.25 else { return nil }
      return CGPoint(x: q.location.x, y: 1 - q.location.y)
    }
    guard let neck = p(.neck) else { continue }
    var torso = 0.0
    let hips = [p(.leftHip), p(.rightHip), p(.root)].compactMap { $0 }
    if !hips.isEmpty { torso = hypot((hips.map { $0.x }.reduce(0, +) / Double(hips.count) - neck.x) * sw / sh, hips.map { $0.y }.reduce(0, +) / Double(hips.count) - neck.y) }
    if let l = p(.leftShoulder), let r = p(.rightShoulder) { torso = max(torso, hypot((l.x - r.x) * sw / sh, l.y - r.y) * 1.5) }
    guard torso > 0.02 else { continue }
    let joints: [Any] = JOINTS.map { j in p(j).map { [r3((($0.x - neck.x) * sw / sh) / torso), r3(($0.y - neck.y) / torso)] as Any } ?? NSNull() }
    // 外观取样区域（按身体大小，横向换算成画面宽的比例）
    let tx = torso * sh / sw
    // 头顶：有眼睛/鼻子就从它们往上找，没有就按脖子往上
    let face = [p(.nose), p(.leftEye), p(.rightEye), p(.leftEar), p(.rightEar)].compactMap { $0 }
    let headY = face.isEmpty ? neck.y - torso * 0.45 : face.map { $0.y }.min()!
    let headX = face.isEmpty ? neck.x : face.map { $0.x }.reduce(0, +) / Double(face.count)
    let hairR = CGRect(x: headX - tx * 0.16, y: headY - torso * 0.32, width: tx * 0.32, height: torso * 0.2)
    let clothR = CGRect(x: neck.x - tx * 0.28, y: neck.y + torso * 0.12, width: tx * 0.56, height: torso * 0.6)
    // 正脸：鼻子和至少一只眼睛看得见（背影、低头埋脸时不算）
    let front = p(.nose) != nil && (p(.leftEye) != nil || p(.rightEye) != nil)
    var c: [String: Any] = ["neck": [r3(neck.x), r3(neck.y)], "torso": r3(torso), "joints": joints, "hair": hueHist(buf, hairR), "cloth": hist(buf, clothR), "front": front]
    if withFp {
      c["fp"] = featurePrint(buf, CGRect(x: neck.x - tx * 0.6, y: neck.y - torso * 0.6, width: tx * 1.2, height: torso * 2.4))
      // 脸部一块（鼻子、眼睛都看得见时）：同款衣服、同色头发的队友，脸才分得开（通用图像特征，不是人脸识别）
      if let nose = p(.nose), let eye = p(.leftEye) ?? p(.rightEye) {
        let fs = max(abs(nose.y - eye.y) * 5, torso * 0.5)
        c["face"] = featurePrint(buf, CGRect(x: nose.x - fs * sh / sw / 2, y: nose.y - fs * 0.6, width: fs * sh / sw, height: fs))
      }
    }
    cands.append(c)
  }
  samples.append(["t": r3(t), "c": cands])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["samples": samples]))
