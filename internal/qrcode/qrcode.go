// Package qrcode implements a QR Code (ISO/IEC 18004) encoder from scratch,
// supporting byte-mode data (i.e. arbitrary UTF-8/ASCII text and URLs),
// versions 1-40, and all four error-correction levels. It has no
// dependencies outside the Go standard library, so it compiles cleanly to
// WebAssembly (GOOS=js GOARCH=wasm) with nothing extra to install.
package qrcode

import "errors"

// Level is a QR Code error-correction level.
type Level int

const (
	LevelL Level = iota // recovers ~7% of codewords
	LevelM              // recovers ~15% of codewords
	LevelQ              // recovers ~25% of codewords
	LevelH              // recovers ~30% of codewords
)

// Code is a fully encoded, masked QR Code ready to render.
type Code struct {
	Version int
	Size    int // modules per side
	Level   Level
	Mask    int
	Modules [][]bool // Modules[y][x]; true = dark module
}

var ErrTooLong = errors.New("qrcode: data too long to fit in any version at the requested error-correction level")

// Encode builds a QR Code for data using byte mode, picking the smallest
// version (1-40) that fits data at the requested error-correction level.
func Encode(data []byte, level Level) (*Code, error) {
	version, err := chooseVersion(len(data), level)
	if err != nil {
		return nil, err
	}
	dataCodewords := buildDataCodewords(data, version, level)
	allCodewords := interleaveBlocks(dataCodewords, version, level)

	m := newMatrix(version)
	m.placeFunctionPatterns()
	dataPositions := m.dataModulePositions()
	m.placeCodewordBits(allCodewords, dataPositions)

	bestMask, bestModules := m.chooseBestMask(level)

	return &Code{
		Version: version,
		Size:    m.size,
		Level:   level,
		Mask:    bestMask,
		Modules: bestModules,
	}, nil
}

// EncodeWithMask is like Encode but forces a specific mask pattern (0-7)
// instead of automatically choosing the lowest-penalty one. Exposed for
// cross-verification against reference implementations during development;
// Encode is what the product actually uses.
func EncodeWithMask(data []byte, level Level, mask int) (*Code, error) {
	version, err := chooseVersion(len(data), level)
	if err != nil {
		return nil, err
	}
	dataCodewords := buildDataCodewords(data, version, level)
	allCodewords := interleaveBlocks(dataCodewords, version, level)

	m := newMatrix(version)
	m.placeFunctionPatterns()
	dataPositions := m.dataModulePositions()
	m.placeCodewordBits(allCodewords, dataPositions)
	m.applyVersionInfo()

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

	return &Code{
		Version: version,
		Size:    m.size,
		Level:   level,
		Mask:    mask,
		Modules: grid,
	}, nil
}

// charCountBits returns the bit-width of the byte-mode character count
// indicator for the given version, per ISO/IEC 18004 Table 3.
func charCountBits(version int) int {
	if version <= 9 {
		return 8
	}
	return 16
}

// dataCapacityCodewords returns how many data codewords (i.e. excluding
// error-correction codewords) the given version+level combination holds.
func dataCapacityCodewords(version int, level Level) int {
	spec := ecBlockTable[version-1][level]
	return spec.NumBlocks1*spec.Data1 + spec.NumBlocks2*spec.Data2
}

func chooseVersion(dataLen int, level Level) (int, error) {
	for version := 1; version <= 40; version++ {
		capacityBits := dataCapacityCodewords(version, level) * 8
		headerBits := 4 + charCountBits(version)
		neededBits := headerBits + dataLen*8
		if neededBits <= capacityBits {
			return version, nil
		}
	}
	return 0, ErrTooLong
}
