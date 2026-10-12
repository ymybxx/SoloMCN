// 舞台段合成（卡点换装 / 分身）：所有场次都没法长时间锁定他的段落（队形舞、人挤人），
// 按拍分成一个个时间窗，每个窗里放此刻最清楚的一场（他放在画面中间），两场都清楚时并排成两列（分身）；
// 窗与窗之间用斜条纹转场换装。第一个窗是上一刀的场次、最后一个窗是下一刀的场次，都用和锁定画面一样的大小，前后无缝接上。
//   array <job.json>
// job: { out, size:[W,H], fps, frames, y, fullTorso, colTorso, tr, theme?:[色], gains?:{文件:[r,g,b]},
//        windows: [ { from, to, cols: [ { file, start, scale?, necks:[[t,x,y,torso]] } ] } ] }
//   from/to：本片帧号（含）；start：本片第 0 帧时这条素材的时间；necks 的 t 是相对本片开头的秒数；
//   scale：这一格素材的放大倍数（不写就按 fullTorso / colTorso 算：一列时用 fullTorso，两列以上用 colTorso）
import AVFoundation
import CoreImage
import Foundation

struct ColIn: Decodable { let file: String; let start: Double; let scale: Double?; let necks: [[Double]] }
struct Win: Decodable { let from: Int; let to: Int; let cols: [ColIn] }
struct Job: Decodable { let out: String; let size: [Int]; let fps: Double; let frames: Int; let y: Double; let fullTorso: Double; let colTorso: Double; let tr: Int?; let theme: [String]?; let gains: [String: [Double]]?; let windows: [Win] }
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
guard CommandLine.arguments.count >= 2, let d = FileManager.default.contents(atPath: CommandLine.arguments[1]) else { fail("用法：array <job.json>") }
let job: Job = { do { return try JSONDecoder().decode(Job.self, from: d) } catch { fail("job.json 格式不对：\(error)") } }()
let W = Double(job.size[0]), H = Double(job.size[1])
let ctx = CIContext(options: [.cacheIntermediates: false])
let rgb = CGColorSpace(name: CGColorSpace.sRGB)!
let frameRect = CGRect(x: 0, y: 0, width: W, height: H)
func hex(_ s: String) -> CIColor? {
  var v: UInt64 = 0; guard Scanner(string: s.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v) else { return nil }
  return CIColor(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
}
let C1 = job.theme?.first.flatMap(hex) ?? CIColor(red: 1, green: 0.93, blue: 0.82)
let C2 = job.theme?.dropFirst().first.flatMap(hex) ?? CIColor(red: 1, green: 0.2, blue: 0.45)
func smooth01(_ x: Double) -> Double { let t = min(1, max(0, x)); return t * t * (3 - 2 * t) }
let TR = max(4, job.tr ?? 10) // 转场帧数

final class FrameSource {
  let reader: AVAssetReader; let output: AVAssetReaderTrackOutput
  var last: (t: Double, buf: CVPixelBuffer)?; var next: (t: Double, buf: CVPixelBuffer)?
  let size: CGSize
  init(file: String, start: Double, dur: Double) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: file))
    guard let track = asset.tracks(withMediaType: .video).first else { fail("没有视频轨：\(file)") }
    size = track.naturalSize
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
    while let nx = next, nx.t < t { last = nx; next = read() }
    guard let nx = next else { return last?.buf }
    guard let l = last else { return nx.buf }
    return abs(l.t - t) <= abs(nx.t - t) ? l.buf : nx.buf
  }
}

// 一格：读帧器 + 平滑后的脖子轨迹（认不到的帧用前后插值；前后都没有就停在最近一次认到的位置）+ 这一格的身体大小
final class Cell {
  let c: ColIn; let src: FrameSource; let sw: Double; let sh: Double; let from: Int; let to: Int
  var nx: [Double] = [], ny: [Double] = []; let torso: Double
  init(_ c: ColIn, from: Int, to: Int) {
    self.c = c; self.from = from; self.to = to
    src = FrameSource(file: c.file, start: c.start + Double(from) / job.fps, dur: Double(to - from + 1) / job.fps)
    sw = Double(src.size.width); sh = Double(src.size.height)
    let ks = c.necks.filter { $0.count >= 4 }.sorted { $0[0] < $1[0] }
    let ts = ks.map { $0[3] }.sorted()
    torso = ts.isEmpty ? 0.3 : ts[min(ts.count - 1, Int(Double(ts.count) * 0.6))]
    for k in 0...max(0, to - from) {
      let t = Double(from + k) / job.fps
      let a = ks.last { $0[0] <= t }, b = ks.first { $0[0] >= t }
      var x = 0.5, y = 0.32
      if let a = a, let b = b, b[0] > a[0] { let f = (t - a[0]) / (b[0] - a[0]); x = a[1] + (b[1] - a[1]) * f; y = a[2] + (b[2] - a[2]) * f }
      else if let c = a ?? b { x = c[1]; y = c[2] }
      nx.append(x); ny.append(y)
    }
    let r = max(1, Int(job.fps * 0.2))
    func sm(_ v: [Double]) -> [Double] { v.indices.map { i in let lo = max(0, i - r), hi = min(v.count - 1, i + r); return v[lo...hi].reduce(0, +) / Double(hi - lo + 1) } }
    nx = sm(nx); ny = sm(ny)
  }
  // 画进 rect（成片坐标，原点左上）：素材放大 scale 倍，他的脖子放在 (rect.midX, y*H)；铺不满就把框挪回素材范围内
  func draw(_ f: Int, rect: CGRect, scale: Double) -> CIImage? {
    guard let buf = src.frame(at: c.start + Double(f) / job.fps) else { return nil }
    let k = min(nx.count - 1, max(0, f - from))
    let S = max(scale, rect.height / sh, rect.width / sw)
    var ox = nx[k] * sw * S - rect.midX, oy = ny[k] * sh * S - job.y * H
    ox = min(max(ox, -rect.minX), sw * S - rect.maxX); oy = min(max(oy, -rect.minY), sh * S - rect.maxY)
    var img = CIImage(cvPixelBuffer: buf)
    if let g = job.gains?[c.file] { img = img.applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: g[0], y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: g[1], z: 0, w: 0), "inputBVector": CIVector(x: 0, y: 0, z: g[2], w: 0)]) }
    var t = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -sh)
    t = t.concatenating(CGAffineTransform(scaleX: S, y: S)).concatenating(CGAffineTransform(translationX: -ox, y: -oy))
    t = t.concatenating(CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -H))
    return img.transformed(by: t).cropped(to: CGRect(x: rect.minX, y: H - rect.maxY, width: rect.width, height: rect.height))
  }
}

// 每个窗的格子；读帧范围多留 TR 帧，下一个窗换进来时旧画面还要继续播
let cells: [[Cell]] = job.windows.enumerated().map { (wi, w) in w.cols.map { Cell($0, from: w.from, to: min(job.frames - 1, w.to + (wi + 1 < job.windows.count ? TR : 0))) } }
func layout(_ wi: Int, _ f: Int) -> CIImage {
  let w = job.windows[wi], n = w.cols.count, cw = W / Double(n)
  var out = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: frameRect)
  for (ci, cell) in cells[wi].enumerated() {
    let rect = CGRect(x: Double(ci) * cw, y: 0, width: cw, height: H)
    let scale = w.cols[ci].scale ?? ((n == 1 ? job.fullTorso : job.colTorso) * H / max(0.05, cell.torso * cell.sh))
    if let img = cell.draw(f, rect: rect, scale: scale) { out = img.composited(over: out) }
  }
  // 两列以上：列之间一道细的主题色分隔线
  if n > 1 { for ci in 1..<n { out = CIImage(color: CIColor(red: C1.red, green: C1.green, blue: C1.blue, alpha: 0.85)).cropped(to: CGRect(x: Double(ci) * cw - 2, y: 0, width: 4, height: H)).composited(over: out) } }
  return out
}
// 斜条纹转场：三道斜条纹错开一点时间从左往右推过去，推过的地方已经是新画面，条纹边缘一道主题色亮边
func stripes(old: CIImage, new: CIImage, t: Double) -> CIImage {
  let shear = CGAffineTransform(a: 1, b: 0, c: -0.36, d: 1, tx: 0, ty: 0)
  var mask = CIImage(color: .black).cropped(to: frameRect)
  var edges = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: frameRect)
  let bandH = H / 3
  for b in 0..<3 {
    let p = smooth01((t - Double(b) * 0.12) / 0.76)
    let x1 = -W * 0.4 + p * W * 1.8
    let y0 = Double(2 - b) * bandH
    let pivot = CGAffineTransform(translationX: 0, y: -(y0 + bandH / 2)).concatenating(shear).concatenating(CGAffineTransform(translationX: 0, y: y0 + bandH / 2))
    mask = CIImage(color: .white).cropped(to: CGRect(x: -W * 0.4, y: y0, width: max(0, x1 + W * 0.4), height: bandH + 1)).transformed(by: pivot).composited(over: mask)
    if p > 0.01 && p < 0.99 { edges = CIImage(color: b == 1 ? C1 : C2).cropped(to: CGRect(x: x1 - W * 0.012, y: y0, width: W * 0.012, height: bandH + 1)).transformed(by: pivot).composited(over: edges) }
  }
  let o = new.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: old, kCIInputMaskImageKey: mask.cropped(to: frameRect)]).cropped(to: frameRect)
  let glow = edges.applyingGaussianBlur(sigma: 14).cropped(to: frameRect)
  return edges.cropped(to: frameRect).composited(over: glow.applyingFilter("CIAdditionCompositing", parameters: [kCIInputBackgroundImageKey: o]).cropped(to: frameRect))
}

let outURL = URL(fileURLWithPath: job.out)
try? FileManager.default.removeItem(at: outURL)
let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(W), AVVideoHeightKey: Int(H),
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 30_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
])
vin.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vin, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: Int(W), kCVPixelBufferHeightKey as String: Int(H)])
writer.add(vin); writer.startWriting(); writer.startSession(atSourceTime: .zero)

for f in 0..<job.frames {
  guard let wi = job.windows.lastIndex(where: { f >= $0.from }) else { continue }
  var out = layout(wi, f)
  let k = f - job.windows[wi].from
  if wi > 0, k < TR { out = stripes(old: layout(wi - 1, f), new: out, t: Double(k + 1) / Double(TR + 1)) }
  while !vin.isReadyForMoreMediaData { usleep(2000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  guard let pbuf = pb else { fail("申请输出帧失败") }
  ctx.render(out.cropped(to: frameRect), to: pbuf, bounds: frameRect, colorSpace: rgb)
  adaptor.append(pbuf, withPresentationTime: CMTime(value: Int64(f), timescale: CMTimeScale(job.fps)))
  if f % 30 == 0 { FileHandle.standardError.write("\r舞台段 \(f)/\(job.frames)".data(using: .utf8)!) }
}
vin.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("写视频失败：\(writer.error?.localizedDescription ?? "未知")") }
FileHandle.standardOutput.write("{\"frames\":\(job.frames)}".data(using: .utf8)!)
