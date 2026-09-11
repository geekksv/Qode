package qrcode

// matrix is the mutable working grid used while constructing a QR Code:
// dark holds module color, isFunc marks modules that belong to a function
// pattern (finder/separator/timing/alignment/format/version/dark-module)
// and must never be touched by data placement or masking.
type matrix struct {
	size   int
	dark   [][]bool
	isFunc [][]bool
}

func newMatrix(version int) *matrix {
	size := version*4 + 17
	m := &matrix{size: size}
	m.dark = make([][]bool, size)
	m.isFunc = make([][]bool, size)
	for i := range m.dark {
		m.dark[i] = make([]bool, size)
		m.isFunc[i] = make([]bool, size)
	}
	return m
}

func (m *matrix) set(row, col int, dark bool) {
	m.dark[row][col] = dark
	m.isFunc[row][col] = true
}

func (m *matrix) placeFunctionPatterns() {
	m.placeFinder(0, 0)
	m.placeFinder(0, m.size-7)
	m.placeFinder(m.size-7, 0)

	m.placeTiming()
	m.placeAlignmentPatterns()
	m.reserveFormatAreas()
	if m.version() >= 7 {
		m.reserveVersionAreas()
	}
}

func (m *matrix) version() int {
	return (m.size - 17) / 4
}

// placeFinder draws a 7x7 finder pattern plus its 1-module light separator
// border, with (row,col) as the finder's top-left corner.
func (m *matrix) placeFinder(row, col int) {
	for dr := -1; dr <= 7; dr++ {
		for dc := -1; dc <= 7; dc++ {
			r, c := row+dr, col+dc
			if r < 0 || r >= m.size || c < 0 || c >= m.size {
				continue
			}
			dark := false
			if dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 {
				// Ring structure of the 7x7 finder pattern.
				if dr == 0 || dr == 6 || dc == 0 || dc == 6 {
					dark = true
				} else if dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4 {
					dark = true
				}
			}
			m.set(r, c, dark)
		}
	}
}

func (m *matrix) placeTiming() {
	for i := 8; i < m.size-8; i++ {
		dark := i%2 == 0
		m.set(6, i, dark)
		m.set(i, 6, dark)
	}
}

func (m *matrix) placeAlignmentPatterns() {
	positions := alignmentPatternPositions[m.version()-1]
	for _, r := range positions {
		for _, c := range positions {
			if m.overlapsFinder(r, c) {
				continue
			}
			m.placeAlignment(r, c)
		}
	}
}

// overlapsFinder reports whether an alignment pattern centered at (r,c)
// would overlap one of the three finder patterns.
func (m *matrix) overlapsFinder(r, c int) bool {
	// An alignment pattern's 5x5 box (center +-2) must not intersect any
	// finder pattern's 8x8 reserved box (7x7 finder + 1-module separator).
	finderBoxes := [][4]int{
		{-1, -1, 7, 7},
		{-1, m.size - 8, 7, m.size - 1},
		{m.size - 8, -1, m.size - 1, 7},
	}
	for _, box := range finderBoxes {
		if r+2 >= box[0] && r-2 <= box[2] && c+2 >= box[1] && c-2 <= box[3] {
			return true
		}
	}
	return false
}

func (m *matrix) placeAlignment(row, col int) {
	for dr := -2; dr <= 2; dr++ {
		for dc := -2; dc <= 2; dc++ {
			dark := dr == -2 || dr == 2 || dc == -2 || dc == 2 || (dr == 0 && dc == 0)
			m.set(row+dr, col+dc, dark)
		}
	}
}

// reserveFormatAreas marks the format-info modules (both copies) as function
// modules with a placeholder value; the real bits are written later by
// applyFormatInfo once a mask has been chosen. Also sets the permanently
// dark module.
func (m *matrix) reserveFormatAreas() {
	for i := 0; i <= 5; i++ {
		m.set(i, 8, false)
	}
	m.set(7, 8, false)
	m.set(8, 8, false)
	m.set(8, 7, false)
	for i := 9; i < 15; i++ {
		m.set(8, 14-i, false)
	}

	for i := 0; i <= 7; i++ {
		m.set(8, m.size-1-i, false)
	}
	for i := 8; i < 15; i++ {
		m.set(m.size-15+i, 8, false)
	}
	m.set(m.size-8, 8, true) // permanently dark module
}

func (m *matrix) reserveVersionAreas() {
	for i := 0; i < 18; i++ {
		a := m.size - 11 + i%3
		b := i / 3
		m.set(b, a, false)
		m.set(a, b, false)
	}
}

// applyVersionInfo computes and writes the BCH(18,6)-encoded version string
// into both reserved copies (versions 7 and up only).
func (m *matrix) applyVersionInfo() {
	v := m.version()
	if v < 7 {
		return
	}
	rem := v
	for i := 0; i < 12; i++ {
		rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
		rem &= 0xFFF
	}
	bits := v<<12 | rem

	for i := 0; i < 18; i++ {
		bit := (bits>>uint(i))&1 == 1
		a := m.size - 11 + i%3
		b := i / 3
		m.set(b, a, bit)
		m.set(a, b, bit)
	}
}

// dataModulePositions returns every non-function module position in the
// standard right-to-left, two-column, boustrophedon zigzag order used to
// place codeword bits (skipping the vertical timing-pattern column).
func (m *matrix) dataModulePositions() [][2]int {
	var positions [][2]int
	upward := true
	for col := m.size - 1; col > 0; col -= 2 {
		if col == 6 {
			col--
		}
		for i := 0; i < m.size; i++ {
			row := i
			if upward {
				row = m.size - 1 - i
			}
			for _, c := range []int{col, col - 1} {
				if !m.isFunc[row][c] {
					positions = append(positions, [2]int{row, c})
				}
			}
		}
		upward = !upward
	}
	return positions
}

// placeCodewordBits writes codeword bits (MSB-first per byte) into the given
// data-module positions, in order. Leftover positions (if any codewords ran
// out first) are left light, which is exactly the spec's "remainder bits"
// behavior.
func (m *matrix) placeCodewordBits(codewords []byte, positions [][2]int) {
	bitIndex := 0
	totalBits := len(codewords) * 8
	for _, pos := range positions {
		dark := false
		if bitIndex < totalBits {
			b := codewords[bitIndex/8]
			shift := uint(7 - bitIndex%8)
			dark = (b>>shift)&1 == 1
		}
		m.dark[pos[0]][pos[1]] = dark
		bitIndex++
	}
}
