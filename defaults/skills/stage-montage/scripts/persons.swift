// 用 macOS 自带的 Vision 人体检测，按固定间隔取帧，找出画面里的每个人（全身框）和他身上衣服的颜色分布。
// 给 montage.mjs 的 track 用：直拍里主角是谁、在不在画面中间、有没有被别人挡住。不做人脸识别，
// 只认位置、大小，和整个人（发色、衣服款式、身形）的外观特征（Vision 的通用图像特征，不是人脸特征）。
//   swift persons.swift <视频> [间隔秒，默认 0.5]
// 输出 JSON：{ "duration": 秒, "samples": [ { "t": 秒, "people": [ { "x","y","w","h","conf","hist":[64],"hair":[64],"fp":[外观特征] } ] } ] }
// 坐标是 0–1，原点在左上角；hist 是框内上半身 4×4×4 的 RGB 颜色分布（加起来是 1）。
import AVFoundation
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("用法：swift persons.swift <视频> [间隔秒]\n".data(using: .utf8)!)
  exit(1)
}
let url = URL(fileURLWithPath: args[1])
let step = args.count >= 3 ? Double(args[2]) ?? 0.5 : 0.5

let asset = AVURLAsset(url: url)
let duration = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 30)
gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
gen.maximumSize = CGSize(width: 960, height: 960)

// 框里一块区域的 4×4×4 RGB 颜色分布。part: 上半身（框的 15%–55% 高、中间 70% 宽）或头发（顶上 0–10% 高、中间 50% 宽）
func histogram(_ image: CGImage, _ r: CGRect, hair: Bool = false) -> [Double] {
  let W = CGFloat(image.width), H = CGFloat(image.height)
  let box = (hair
    ? CGRect(x: (r.minX + r.width * 0.25) * W, y: r.minY * H, width: r.width * 0.5 * W, height: r.height * 0.1 * H)
    : CGRect(x: (r.minX + r.width * 0.15) * W, y: (r.minY + r.height * 0.15) * H, width: r.width * 0.7 * W, height: r.height * 0.4 * H)).integral
  guard box.width >= 4, box.height >= 4, let crop = image.cropping(to: box) else { return [] }
  let w = 24, h = 24
  var px = [UInt8](repeating: 0, count: w * h * 4)
  guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
  ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
  var hist = [Double](repeating: 0, count: 64)
  for i in 0..<(w * h) {
    let r = Int(px[i * 4]) >> 6, g = Int(px[i * 4 + 1]) >> 6, b = Int(px[i * 4 + 2]) >> 6
    hist[r * 16 + g * 4 + b] += 1
  }
  return hist.map { ($0 / Double(w * h) * 1000).rounded() / 1000 }
}

// 整个人的外观特征：框稍微放大一点（带上头发），用 Vision 的图像特征向量
func featurePrint(_ image: CGImage, _ r: CGRect) -> [Float] {
  let W = CGFloat(image.width), H = CGFloat(image.height)
  let box = CGRect(x: max(0, r.minX - r.width * 0.05) * W, y: max(0, r.minY - r.height * 0.03) * H, width: min(1, r.width * 1.1) * W, height: min(1, r.height * 1.03) * H).intersection(CGRect(x: 0, y: 0, width: W, height: H)).integral
  guard box.width >= 16, box.height >= 16, let crop = image.cropping(to: box) else { return [] }
  let req = VNGenerateImageFeaturePrintRequest()
  req.imageCropAndScaleOption = .scaleFit
  guard (try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([req])) != nil, let obs = req.results?.first else { return [] }
  let n = obs.elementCount
  var out = [Float](repeating: 0, count: n)
  obs.data.withUnsafeBytes { raw in
    if obs.elementType == .float { for i in 0..<n { out[i] = raw.load(fromByteOffset: i * 4, as: Float.self) } }
    else { for i in 0..<n { out[i] = Float(raw.load(fromByteOffset: i * 8, as: Double.self)) } }
  }
  // 归一化，再降到 3 位小数，JSON 小一点
  let norm = sqrt(out.reduce(0) { $0 + $1 * $1 }) + 1e-9
  return out.map { (($0 / norm) * 1000).rounded() / 1000 }
}

var samples: [[String: Any]] = []
var t = 0.0
while t < duration {
  var actual = CMTime.zero
  if let img = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: &actual) {
    let req = VNDetectHumanRectanglesRequest()
    req.upperBodyOnly = false
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    var people: [[String: Any]] = []
    for o in req.results ?? [] {
      // Vision 的原点在左下角，换成左上角
      let b = o.boundingBox
      let r = CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height)
      people.append([
        "x": (r.minX * 1000).rounded() / 1000, "y": (r.minY * 1000).rounded() / 1000,
        "w": (r.width * 1000).rounded() / 1000, "h": (r.height * 1000).rounded() / 1000,
        "conf": (Double(o.confidence) * 100).rounded() / 100, "hist": histogram(img, r), "hair": histogram(img, r, hair: true), "fp": featurePrint(img, r),
      ])
    }
    samples.append(["t": (CMTimeGetSeconds(actual) * 1000).rounded() / 1000, "people": people])
  }
  t += step
}
let out: [String: Any] = ["duration": duration, "samples": samples]
let data = try JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
