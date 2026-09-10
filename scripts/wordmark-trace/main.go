// Command wordmark-trace extracts the 华山论剑 wordmark from a source poster and
// traces it into an SVG path. It is a one-off asset authoring tool: the generated
// SVG is committed under internal/server/web/assets and the tool is kept so the
// asset can be regenerated or refined later.
//
// Usage:
//
//	go run ./scripts/wordmark-trace crop  -in <jpg> -out <png> -rect x,y,w,h [-scale 4]
//	go run ./scripts/wordmark-trace mask  -in <jpg> -out <png> -rect x,y,w,h [-scale 4] [tuning flags]
//	go run ./scripts/wordmark-trace probe -in <jpg> -rect x,y,w,h [tuning flags]
//	go run ./scripts/wordmark-trace trace -in <jpg> -out <svg> -rect x,y,w,h [tuning flags]
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
)

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		log.Fatal("wordmark-trace: missing subcommand (crop|mask|probe|trace)")
	}
	cmd := os.Args[1]

	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	in := fs.String("in", "", "source image path")
	out := fs.String("out", "", "output path")
	rect := fs.String("rect", "", "crop rect as x,y,w,h")
	scale := fs.Int("scale", 4, "nearest-neighbour upscale for crop/mask preview")
	super := fs.Int("super", 4, "bilinear supersample factor applied before thresholding")
	cut := fs.String("cut", "", "semicolon-separated rects (x,y,w,h, crop-relative) to blank before thresholding")
	minLuma := fs.Int("min-luma", 225, "minimum luma for a character-body pixel")
	maxSat := fs.Int("max-sat", 55, "maximum channel spread for a character-body pixel")
	despeckles := fs.Int("despeckle", 1, "majority-filter passes; each one slightly rounds corners")
	minArea := fs.Int("min-area", 24, "drop traced contours smaller than this many supersampled pixels")
	tolerance := fs.Float64("tolerance", 1.5, "Douglas-Peucker tolerance in supersampled pixels")
	trim := fs.Bool("trim", true, "shift the traced outline to the origin and fit the viewBox to it")
	padX := fs.Float64("pad-x", 0, "extra viewBox width in source pixels, e.g. to leave room for an extrude")
	padY := fs.Float64("pad-y", 0, "extra viewBox height in source pixels")
	if err := fs.Parse(os.Args[2:]); err != nil {
		log.Fatalf("wordmark-trace: parse flags: %v", err)
	}
	if *in == "" {
		log.Fatal("wordmark-trace: -in is required")
	}
	switch cmd {
	case "crop", "mask", "trace":
		if *out == "" {
			log.Fatalf("wordmark-trace: -out is required for %s", cmd)
		}
	case "probe":
	default:
		log.Fatalf("wordmark-trace: unknown subcommand %q", cmd)
	}

	src, err := loadJPEG(*in)
	if err != nil {
		log.Fatalf("wordmark-trace: load %s: %v", *in, err)
	}
	region, err := parseRect(*rect, src.Bounds())
	if err != nil {
		log.Fatalf("wordmark-trace: parse rect: %v", err)
	}

	cuts, err := parseRects(*cut)
	if err != nil {
		log.Fatalf("wordmark-trace: parse cut: %v", err)
	}

	switch cmd {
	case "crop":
		if err := writePNG(*out, upscale(cropTo(src, region), *scale)); err != nil {
			log.Fatalf("wordmark-trace: write crop: %v", err)
		}
		log.Printf("wordmark-trace: wrote crop %s (%dx%d source, %dx upscale)", *out, region.Dx(), region.Dy(), *scale)
	case "mask":
		m := buildMask(cropTo(src, region), cuts, *super, *despeckles, *minLuma, *maxSat)
		if err := writePNG(*out, upscale(m.toImage(), max(1, *scale / *super))); err != nil {
			log.Fatalf("wordmark-trace: write mask: %v", err)
		}
		log.Printf("wordmark-trace: wrote mask %s (%dx%d supersampled, %d pixels set)", *out, m.w, m.h, m.count())
	case "probe":
		probe(cropTo(src, region), cuts, *minLuma, *maxSat)
	case "trace":
		m := buildMask(cropTo(src, region), cuts, *super, *despeckles, *minLuma, *maxSat)
		svg := m.toSVG(*minArea, *tolerance, float64(*super), *trim, *padX, *padY)
		if err := os.WriteFile(*out, []byte(svg), 0o644); err != nil {
			log.Fatalf("wordmark-trace: write svg: %v", err)
		}
		log.Printf("wordmark-trace: wrote svg %s (%d bytes)", *out, len(svg))
	default:
		log.Fatalf("wordmark-trace: unknown subcommand %q", cmd)
	}
}

func loadJPEG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return jpeg.Decode(f)
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func parseRect(spec string, bounds image.Rectangle) (image.Rectangle, error) {
	if spec == "" {
		return bounds, nil
	}
	parts := strings.Split(spec, ",")
	if len(parts) != 4 {
		return image.Rectangle{}, fmt.Errorf("want x,y,w,h, got %q", spec)
	}
	nums := make([]int, 4)
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return image.Rectangle{}, fmt.Errorf("field %d: %w", i, err)
		}
		nums[i] = n
	}
	r := image.Rect(nums[0], nums[1], nums[0]+nums[2], nums[1]+nums[3]).Intersect(bounds)
	if r.Empty() {
		return image.Rectangle{}, fmt.Errorf("rect %q does not intersect image bounds %v", spec, bounds)
	}
	return r, nil
}

func parseRects(spec string) ([]image.Rectangle, error) {
	if strings.TrimSpace(spec) == "" {
		return nil, nil
	}
	var out []image.Rectangle
	for _, part := range strings.Split(spec, ";") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		r, err := parseRect(part, image.Rect(-1e6, -1e6, 1e6, 1e6))
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func cropTo(src image.Image, r image.Rectangle) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		for x := 0; x < r.Dx(); x++ {
			dst.Set(x, y, src.At(r.Min.X+x, r.Min.Y+y))
		}
	}
	return dst
}

func upscale(src image.Image, factor int) image.Image {
	if factor <= 1 {
		return src
	}
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx()*factor, b.Dy()*factor))
	for y := 0; y < dst.Bounds().Dy(); y++ {
		for x := 0; x < dst.Bounds().Dx(); x++ {
			dst.Set(x, y, src.At(b.Min.X+x/factor, b.Min.Y+y/factor))
		}
	}
	return dst
}

// probe measures the wordmark's three ink layers straight off the source so the
// SVG palette is sampled rather than eyeballed: the near-white character body,
// the warm gold rim around it, and the neutral extrude cast to one side. It also
// reports the body colour per vertical band, which is how the body gradient is
// derived, and the body-to-extrude centroid offset, which gives the extrude
// direction.
func probe(src *image.RGBA, cuts []image.Rectangle, minLuma, maxSat int) {
	for _, r := range cuts {
		blank(src, r)
	}
	b := src.Bounds()

	type acc struct {
		n                int
		r, g, bl, sx, sy float64
	}
	add := func(a *acc, c color.RGBA, x, y int) {
		a.n++
		a.r += float64(c.R)
		a.g += float64(c.G)
		a.bl += float64(c.B)
		a.sx += float64(x)
		a.sy += float64(y)
	}
	mean := func(a acc) string {
		if a.n == 0 {
			return "n/a"
		}
		return fmt.Sprintf("#%02x%02x%02x", int(a.r/float64(a.n)+0.5), int(a.g/float64(a.n)+0.5), int(a.bl/float64(a.n)+0.5))
	}

	const bands = 6
	var body, gold, extrude acc
	var bodyBands, goldBands [bands]acc
	bodyAt := map[int]bool{}
	extrudeAt := map[int]bool{}
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			c := src.RGBAAt(x, y)
			r, g, bl := int(c.R), int(c.G), int(c.B)
			luma := (r*299 + g*587 + bl*114) / 1000
			spread := max(r, max(g, bl)) - min(r, min(g, bl))
			band := min(y*bands/b.Dy(), bands-1)
			switch {
			case luma >= minLuma && spread <= maxSat:
				add(&body, c, x, y)
				add(&bodyBands[band], c, x, y)
				bodyAt[y*b.Dx()+x] = true
			case luma >= 110 && spread > maxSat && r > bl && g > bl:
				add(&gold, c, x, y) // warm, mid-to-bright: the gold rim
				add(&goldBands[band], c, x, y)
			case luma >= 95 && luma < minLuma && spread <= maxSat:
				add(&extrude, c, x, y) // neutral mid grey: the extrude
				extrudeAt[y*b.Dx()+x] = true
			}
		}
	}

	log.Printf("body    %s  (%d px)", mean(body), body.n)
	log.Printf("gold    %s  (%d px)", mean(gold), gold.n)
	log.Printf("extrude %s  (%d px)", mean(extrude), extrude.n)
	for i := range bands {
		log.Printf("  band %d/%d  body %s (%d px)  gold %s (%d px)",
			i+1, bands, mean(bodyBands[i]), bodyBands[i].n, mean(goldBands[i]), goldBands[i].n)
	}

	// The extrude is the body shape displaced by a fixed offset, so the offset is
	// whichever shift lands the most body pixels on top of extrude pixels.
	bestDX, bestDY, bestHits := 0, 0, 0
	for dy := 0; dy <= 10; dy++ {
		for dx := -10; dx <= 10; dx++ {
			hits := 0
			for idx := range bodyAt {
				x, y := idx%b.Dx()+dx, idx/b.Dx()+dy
				if x < 0 || y < 0 || x >= b.Dx() || y >= b.Dy() {
					continue
				}
				if extrudeAt[y*b.Dx()+x] {
					hits++
				}
			}
			if hits > bestHits {
				bestDX, bestDY, bestHits = dx, dy, hits
			}
		}
	}
	log.Printf("extrude offset %+d,%+d px (%d of %d extrude px explained)", bestDX, bestDY, bestHits, extrude.n)
}

// mask is a binary bitmap of the pixels that belong to the wordmark.
type mask struct {
	w, h int
	bits []bool
}

func (m *mask) at(x, y int) bool {
	if x < 0 || y < 0 || x >= m.w || y >= m.h {
		return false
	}
	return m.bits[y*m.w+x]
}

func (m *mask) set(x, y int, v bool) {
	if x < 0 || y < 0 || x >= m.w || y >= m.h {
		return
	}
	m.bits[y*m.w+x] = v
}

func (m *mask) count() int {
	n := 0
	for _, b := range m.bits {
		if b {
			n++
		}
	}
	return n
}

func (m *mask) toImage() image.Image {
	img := image.NewGray(image.Rect(0, 0, m.w, m.h))
	for y := 0; y < m.h; y++ {
		for x := 0; x < m.w; x++ {
			if m.at(x, y) {
				img.SetGray(x, y, color.Gray{Y: 0})
			} else {
				img.SetGray(x, y, color.Gray{Y: 255})
			}
		}
	}
	return img
}

// buildMask keeps the pixels that form the wordmark's letterform: the white
// character body. The gold rim and the coloured backdrop are both saturated, so
// requiring a bright and near-neutral pixel isolates the strokes themselves.
//
// The crop is bilinearly supersampled first. Because the source edges are
// anti-aliased, thresholding the interpolated image puts the boundary at a
// sub-pixel position, and the straight strokes of this typeface then simplify
// into genuinely straight segments instead of stair-stepped ones.
func buildMask(src *image.RGBA, cuts []image.Rectangle, super, despeckles, minLuma, maxSat int) *mask {
	for _, r := range cuts {
		blank(src, r)
	}
	if super < 1 {
		super = 1
	}
	b := src.Bounds()
	w, h := b.Dx()*super, b.Dy()*super
	m := &mask{w: w, h: h, bits: make([]bool, w*h)}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// Sample at the supersampled pixel centre, mapped back to source space.
			sx := (float64(x)+0.5)/float64(super) - 0.5
			sy := (float64(y)+0.5)/float64(super) - 0.5
			r, g, bl := bilinear(src, sx, sy)
			luma := (r*299 + g*587 + bl*114) / 1000
			hi, lo := math.Max(r, math.Max(g, bl)), math.Min(r, math.Min(g, bl))
			m.set(x, y, luma >= float64(minLuma) && hi-lo <= float64(maxSat))
		}
	}
	for i := 0; i < despeckles; i++ {
		m = despeckle(m)
	}
	return m
}

func blank(img *image.RGBA, r image.Rectangle) {
	r = r.Intersect(img.Bounds())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			img.SetRGBA(x, y, color.RGBA{A: 255})
		}
	}
}

func bilinear(src *image.RGBA, x, y float64) (r, g, b float64) {
	bounds := src.Bounds()
	clampX := func(v int) int { return min(max(v, bounds.Min.X), bounds.Max.X-1) }
	clampY := func(v int) int { return min(max(v, bounds.Min.Y), bounds.Max.Y-1) }
	x0, y0 := int(math.Floor(x)), int(math.Floor(y))
	fx, fy := x-float64(x0), y-float64(y0)
	for i := 0; i < 2; i++ {
		for j := 0; j < 2; j++ {
			c := src.RGBAAt(clampX(x0+j), clampY(y0+i))
			wx := 1 - fx
			if j == 1 {
				wx = fx
			}
			wy := 1 - fy
			if i == 1 {
				wy = fy
			}
			wgt := wx * wy
			r += float64(c.R) * wgt
			g += float64(c.G) * wgt
			b += float64(c.B) * wgt
		}
	}
	return r, g, b
}

// despeckle flips a pixel when at least six of its eight neighbours disagree with it.
func despeckle(m *mask) *mask {
	out := &mask{w: m.w, h: m.h, bits: make([]bool, len(m.bits))}
	for y := 0; y < m.h; y++ {
		for x := 0; x < m.w; x++ {
			on := 0
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					if dx == 0 && dy == 0 {
						continue
					}
					if m.at(x+dx, y+dy) {
						on++
					}
				}
			}
			switch {
			case on >= 6:
				out.set(x, y, true)
			case on <= 2:
				out.set(x, y, false)
			default:
				out.set(x, y, m.at(x, y))
			}
		}
	}
	return out
}

type point struct{ X, Y float64 }

// toSVG traces every mask region boundary and emits them as one path, mapping
// supersampled pixel coordinates back to source-pixel units.
func (m *mask) toSVG(minArea int, tolerance, super float64, trim bool, padX, padY float64) string {
	var paths [][]point
	for _, c := range m.contours(minArea) {
		if simple := simplify(c, tolerance); len(simple) >= 3 {
			paths = append(paths, scalePoints(simple, 1/super))
		}
	}

	viewW, viewH := float64(m.w)/super, float64(m.h)/super
	if trim && len(paths) > 0 {
		lo, hi := boundsOf(paths)
		for _, c := range paths {
			for i := range c {
				c[i].X -= lo.X
				c[i].Y -= lo.Y
			}
		}
		viewW, viewH = hi.X-lo.X, hi.Y-lo.Y
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 %s %s\">\n",
		trimNum(viewW+padX), trimNum(viewH+padY))
	sb.WriteString("  <path fill-rule=\"evenodd\" d=\"")
	for i, c := range paths {
		if i > 0 {
			sb.WriteString(" ")
		}
		fmt.Fprintf(&sb, "M%s", fmtPoint(c[0]))
		for _, p := range c[1:] {
			fmt.Fprintf(&sb, "L%s", fmtPoint(p))
		}
		sb.WriteString("Z")
	}
	sb.WriteString("\"/>\n</svg>\n")
	return sb.String()
}

func scalePoints(pts []point, factor float64) []point {
	out := make([]point, len(pts))
	for i, p := range pts {
		out[i] = point{X: p.X * factor, Y: p.Y * factor}
	}
	return out
}

func boundsOf(paths [][]point) (lo, hi point) {
	lo = point{X: math.Inf(1), Y: math.Inf(1)}
	hi = point{X: math.Inf(-1), Y: math.Inf(-1)}
	for _, c := range paths {
		for _, p := range c {
			lo.X, lo.Y = math.Min(lo.X, p.X), math.Min(lo.Y, p.Y)
			hi.X, hi.Y = math.Max(hi.X, p.X), math.Max(hi.Y, p.Y)
		}
	}
	return lo, hi
}

func fmtPoint(p point) string {
	return trimNum(p.X) + " " + trimNum(p.Y)
}

func trimNum(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}

// contours returns the outline of every filled region plus the outline of every
// enclosed hole. Holes are emitted as separate subpaths and rely on the path's
// evenodd fill rule to punch through, so their winding order does not matter.
func (m *mask) contours(minArea int) [][]point {
	var result [][]point

	seen := make([]bool, len(m.bits))
	m.eachRegion(seen, func(area int, cells map[int]bool) {
		if area >= minArea {
			result = append(result, m.traceRegion(cells))
		}
	})

	// Background components that cannot reach the border are holes.
	bg := m.inverted()
	seenBG := make([]bool, len(bg.bits))
	for x := 0; x < bg.w; x++ {
		bg.floodFill(x, 0, seenBG)
		bg.floodFill(x, bg.h-1, seenBG)
	}
	for y := 0; y < bg.h; y++ {
		bg.floodFill(0, y, seenBG)
		bg.floodFill(bg.w-1, y, seenBG)
	}
	bg.eachRegion(seenBG, func(area int, cells map[int]bool) {
		if area >= minArea {
			result = append(result, bg.traceRegion(cells))
		}
	})
	return result
}

func (m *mask) eachRegion(seen []bool, fn func(area int, cells map[int]bool)) {
	for y := 0; y < m.h; y++ {
		for x := 0; x < m.w; x++ {
			if !m.at(x, y) || seen[y*m.w+x] {
				continue
			}
			fn(m.floodFill(x, y, seen))
		}
	}
}

func (m *mask) inverted() *mask {
	out := &mask{w: m.w, h: m.h, bits: make([]bool, len(m.bits))}
	for i, b := range m.bits {
		out.bits[i] = !b
	}
	return out
}

func (m *mask) floodFill(sx, sy int, seen []bool) (int, map[int]bool) {
	cells := map[int]bool{}
	stack := []image.Point{{X: sx, Y: sy}}
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if !m.at(p.X, p.Y) {
			continue
		}
		idx := p.Y*m.w + p.X
		if seen[idx] {
			continue
		}
		seen[idx] = true
		cells[idx] = true
		stack = append(stack,
			image.Point{X: p.X + 1, Y: p.Y}, image.Point{X: p.X - 1, Y: p.Y},
			image.Point{X: p.X, Y: p.Y + 1}, image.Point{X: p.X, Y: p.Y - 1})
	}
	return len(cells), cells
}

// traceRegion emits the pixel-edge outline of a region by walking its square
// boundary one unit edge at a time, starting from the region's top-left cell.
func (m *mask) traceRegion(cells map[int]bool) []point {
	in := func(x, y int) bool {
		if x < 0 || y < 0 || x >= m.w || y >= m.h {
			return false
		}
		return cells[y*m.w+x]
	}
	// Find the top-left cell of the region as the walk seed.
	sx, sy := m.w, m.h
	for idx := range cells {
		x, y := idx%m.w, idx/m.w
		if y < sy || (y == sy && x < sx) {
			sx, sy = x, y
		}
	}

	// Walk the boundary: position sits on pixel corners, direction rotates at edges.
	type dir struct{ dx, dy int }
	dirs := []dir{{1, 0}, {0, 1}, {-1, 0}, {0, -1}} // right, down, left, up
	x, y, d := sx, sy, 0
	start := point{X: float64(sx), Y: float64(sy)}
	pts := []point{start}
	for i := 0; i < m.w*m.h*8; i++ {
		// Keep filled cells on the walk's right: if the cell ahead-left is filled the
		// boundary turns left, if neither cell ahead is filled it turns right, and
		// otherwise it carries straight on along the same edge.
		left, right := cellsAtCorner(x, y, d, in)
		switch {
		case left:
			d = (d + 3) % 4
		case !right:
			d = (d + 1) % 4
		}
		x += dirs[d].dx
		y += dirs[d].dy
		p := point{X: float64(x), Y: float64(y)}
		pts = append(pts, p)
		if p == start {
			break
		}
	}
	return pts
}

// cellsAtCorner reports the two cells straddling the edge that leaves corner
// (x,y) in direction d: the one on the walk's left and the one on its right.
func cellsAtCorner(x, y, d int, in func(int, int) bool) (left, right bool) {
	switch d {
	case 0: // moving right: left cell is above the edge, right cell is below
		return in(x, y-1), in(x, y)
	case 1: // moving down
		return in(x, y), in(x-1, y)
	case 2: // moving left
		return in(x-1, y), in(x-1, y-1)
	default: // moving up
		return in(x-1, y-1), in(x, y-1)
	}
}

// simplify runs Douglas-Peucker over a closed contour.
func simplify(pts []point, tolerance float64) []point {
	if len(pts) < 3 || tolerance <= 0 {
		return pts
	}
	keep := make([]bool, len(pts))
	keep[0], keep[len(pts)-1] = true, true
	var walk func(lo, hi int)
	walk = func(lo, hi int) {
		if hi <= lo+1 {
			return
		}
		maxDist, maxIdx := 0.0, lo
		for i := lo + 1; i < hi; i++ {
			if d := pointSegmentDistance(pts[i], pts[lo], pts[hi]); d > maxDist {
				maxDist, maxIdx = d, i
			}
		}
		if maxDist <= tolerance {
			return
		}
		keep[maxIdx] = true
		walk(lo, maxIdx)
		walk(maxIdx, hi)
	}
	walk(0, len(pts)-1)

	out := pts[:0:0]
	for i, k := range keep {
		if k {
			out = append(out, pts[i])
		}
	}
	return out
}

func pointSegmentDistance(p, a, b point) float64 {
	dx, dy := b.X-a.X, b.Y-a.Y
	if dx == 0 && dy == 0 {
		return math.Hypot(p.X-a.X, p.Y-a.Y)
	}
	t := ((p.X-a.X)*dx + (p.Y-a.Y)*dy) / (dx*dx + dy*dy)
	switch {
	case t < 0:
		t = 0
	case t > 1:
		t = 1
	}
	return math.Hypot(p.X-(a.X+t*dx), p.Y-(a.Y+t*dy))
}
