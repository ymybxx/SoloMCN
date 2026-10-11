// 逐帧提取主角的全身骨架（macOS Vision 人体姿态，不做人脸识别），给换装选场次、找动作最一致的接点用。
//   pose <job.json>
// job: { file, step, track: [[t, cx, cy, w, h]] }  track 是认人得到的主角框（素材时间、0–1 坐标），用来认准是他
// 输出 JSON：{ samples: [ { t, ok, neck:[x,y], torso, joints:[[x,y]|null ×12] } ] }
// joints 是肩、肘、腕、胯、膝、踝相对脖子、按身体大小归一后的位置；neck、torso 是 0–1 坐标和占画面高的比例
import AVFoundation
import Foundation
import Vision

struct Job: Decodable { let file: String; let step: Double; let track: [[Double]] }
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
var prevNeck: CGPoint? = nil
let r3 = { (x: Double) in (x * 1000).rounded() / 1000 }

while let sb = out.copyNextSampleBuffer() {
  let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
  guard t + 1e-6 >= next, let buf = CMSampleBufferGetImageBuffer(sb) else { continue }
  next = t + job.step
  try? VNImageRequestHandler(cvPixelBuffer: buf, options: [:]).perform([req])
  // 候选：每个人的脖子、身体大小、关节
  var cands: [(neck: CGPoint, torso: Double, joints: [Any])] = []
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
    cands.append((neck, torso, joints))
  }
  // 认人：附近 0.35 秒内的主角框里、靠框顶的那个；没有框就和上一帧连贯
  let tb = job.track.filter { $0.count == 5 && abs($0[0] - t) <= 0.35 }.min { abs($0[0] - t) < abs($1[0] - t) }
  var best: (neck: CGPoint, torso: Double, joints: [Any])? = nil
  if let tb = tb {
    let box = CGRect(x: tb[1] - tb[3] * 0.65, y: tb[2] - tb[4] * 0.6, width: tb[3] * 1.3, height: tb[4] * 1.2)
    let ref = CGPoint(x: tb[1], y: tb[2] - tb[4] * 0.3)
    best = cands.filter { box.contains($0.neck) }.min { hypot($0.neck.x - ref.x, $0.neck.y - ref.y) < hypot($1.neck.x - ref.x, $1.neck.y - ref.y) }
  } else if let pn = prevNeck {
    best = cands.filter { hypot($0.neck.x - pn.x, $0.neck.y - pn.y) < 0.08 }.min { hypot($0.neck.x - pn.x, $0.neck.y - pn.y) < hypot($1.neck.x - pn.x, $1.neck.y - pn.y) }
  }
  if let b = best {
    prevNeck = b.neck
    samples.append(["t": r3(t), "ok": true, "neck": [r3(b.neck.x), r3(b.neck.y)], "torso": r3(b.torso), "joints": b.joints])
  } else {
    samples.append(["t": r3(t), "ok": false])
  }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["samples": samples]))
