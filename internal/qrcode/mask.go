package qrcode

// maskCondition returns whether the mask pattern flips the module at
// (row, col), per ISO/IEC 18004 Table 10.
func maskCondition(pattern, row, col int) bool {
	switch pattern {
	case 0:
		return (row+col)%2 == 0
	case 1:
		return row%2 == 0
	case 2:
		return col%3 == 0
	case 3:
		return (row+col)%3 == 0
	case 4:
		return (row/2+col/3)%2 == 0
	case 5:
		return (row*col)%2+(row*col)%3 == 0
	case 6:
		return ((row*col)%2+(row*col)%3)%2 == 0
	case 7:
		return ((row+col)%2+(row*col)%3)%2 == 0
	}
	return false
}

func cloneDark(src [][]bool) [][]bool {
	out := make([][]bool, len(src))
	for i, row := range src {
		out[i] = append([]bool(nil), row...)
	}
	return out
}

// chooseBestMask tries all 8 mask patterns and returns the index and final
// module grid of whichever scores lowest under the standard ISO 18004
// penalty rules. All 8 candidates are structurally valid, scannable QR
// codes; this only optimizes which is least likely to confuse a scanner.
func (m *matrix) chooseBestMask(level Level) (int, [][]bool) {
	m.applyVersionInfo() // mask-independent, safe to draw once up front

	bestMask := -1
	bestPenalty := 1 << 30
	var bestGrid [][]bool

	for mask := 0; mask < 8; mask++ {
		grid := cloneDark(m.dark)
		for row := 0; row < m.size; row++ {
			for col := 0; col < m.size; col++ {
				if m.isFunc[row][col] {
					continue
				}
				if maskCondition(mask, row, col) {
					grid[row][col] = !grid[row][col]
				}
			}
		}
		writeFormatInfo(grid, m.size, level, mask)

		penalty := penaltyScore(grid, m.size)
		if penalty < bestPenalty {
			bestPenalty = penalty
			bestMask = mask
			bestGrid = grid
		}
	}

	return bestMask, bestGrid
}

// writeFormatInfo computes and writes the BCH(15,5)-encoded format string
// directly into a module grid (used for scoring candidates during mask
// selection; matrix.applyFormatInfo does the same thing for the chosen one).
func writeFormatInfo(grid [][]bool, size int, level Level, mask int) {
	levelBits := map[Level]int{LevelL: 0b01, LevelM: 0b00, LevelQ: 0b11, LevelH: 0b10}[level]
	data := levelBits<<3 | mask
	rem := data
	for i := 0; i < 10; i++ {
		rem = (rem << 1) ^ ((rem >> 9) * 0x537)
		rem &= 0x3FF
	}
	bits := (data<<10 | rem) ^ 0x5412
	getBit := func(i int) bool { return (bits>>uint(i))&1 == 1 }

	for i := 0; i <= 5; i++ {
		grid[i][8] = getBit(i)
	}
	grid[7][8] = getBit(6)
	grid[8][8] = getBit(7)
	grid[8][7] = getBit(8)
	for i := 9; i < 15; i++ {
		grid[8][14-i] = getBit(i)
	}
	for i := 0; i <= 7; i++ {
		grid[8][size-1-i] = getBit(i)
	}
	for i := 8; i < 15; i++ {
		grid[size-15+i][8] = getBit(i)
	}
	grid[size-8][8] = true
}

var penaltyPatternA = []bool{true, false, true, true, true, false, true, false, false, false, false}
var penaltyPatternB = []bool{false, false, false, false, true, false, true, true, true, false, true}

func matchesPenaltyPattern(line []bool) int {
	count := 0
	for i := 0; i+11 <= len(line); i++ {
		window := line[i : i+11]
		if boolSliceEqual(window, penaltyPatternA) || boolSliceEqual(window, penaltyPatternB) {
			count++
		}
	}
	return count
}

func boolSliceEqual(a, b []bool) bool {
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// penaltyScore implements the four ISO/IEC 18004 mask-evaluation rules.
func penaltyScore(grid [][]bool, size int) int {
	penalty := 0

	// Rule 1: runs of 5+ same-colored modules in a row or column.
	scoreRuns := func(get func(i int) bool, n int) int {
		p := 0
		runLen := 1
		for i := 1; i < n; i++ {
			if get(i) == get(i-1) {
				runLen++
			} else {
				if runLen >= 5 {
					p += 3 + (runLen - 5)
				}
				runLen = 1
			}
		}
		if runLen >= 5 {
			p += 3 + (runLen - 5)
		}
		return p
	}
	for row := 0; row < size; row++ {
		r := row
		penalty += scoreRuns(func(i int) bool { return grid[r][i] }, size)
	}
	for col := 0; col < size; col++ {
		c := col
		penalty += scoreRuns(func(i int) bool { return grid[i][c] }, size)
	}

	// Rule 2: 2x2 blocks of the same color.
	for row := 0; row < size-1; row++ {
		for col := 0; col < size-1; col++ {
			v := grid[row][col]
			if grid[row][col+1] == v && grid[row+1][col] == v && grid[row+1][col+1] == v {
				penalty += 3
			}
		}
	}

	// Rule 3: finder-like 1:1:3:1:1 patterns with a 4-module light run.
	for row := 0; row < size; row++ {
		penalty += 40 * matchesPenaltyPattern(grid[row])
	}
	for col := 0; col < size; col++ {
		line := make([]bool, size)
		for row := 0; row < size; row++ {
			line[row] = grid[row][col]
		}
		penalty += 40 * matchesPenaltyPattern(line)
	}

	// Rule 4: overall dark/light balance vs. 50%.
	dark := 0
	for row := 0; row < size; row++ {
		for col := 0; col < size; col++ {
			if grid[row][col] {
				dark++
			}
		}
	}
	total := size * size
	percent := dark * 100 / total
	deviation := percent - 50
	if deviation < 0 {
		deviation = -deviation
	}
	penalty += (deviation / 5) * 10

	return penalty
}
