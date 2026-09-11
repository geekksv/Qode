package qrcode

// bitWriter accumulates bits MSB-first into a byte slice.
type bitWriter struct {
	bytes   []byte
	bitLen  int // number of bits currently written
}

func (w *bitWriter) writeBits(value int, numBits int) {
	for i := numBits - 1; i >= 0; i-- {
		bit := (value >> uint(i)) & 1
		byteIndex := w.bitLen / 8
		for byteIndex >= len(w.bytes) {
			w.bytes = append(w.bytes, 0)
		}
		if bit == 1 {
			w.bytes[byteIndex] |= 1 << uint(7-(w.bitLen%8))
		}
		w.bitLen++
	}
}

// buildDataCodewords builds the full padded data-codeword stream (mode
// indicator + character count + byte-mode data + terminator + bit padding
// + alternating pad codewords) for the given version/level's capacity.
func buildDataCodewords(data []byte, version int, level Level) []byte {
	w := &bitWriter{}

	// Mode indicator for byte mode = 0100.
	w.writeBits(0b0100, 4)
	w.writeBits(len(data), charCountBits(version))
	for _, b := range data {
		w.writeBits(int(b), 8)
	}

	capacityBits := dataCapacityCodewords(version, level) * 8

	// Terminator: up to 4 zero bits, only as many as remain.
	remaining := capacityBits - w.bitLen
	if remaining > 4 {
		remaining = 4
	}
	if remaining > 0 {
		w.writeBits(0, remaining)
	}

	// Pad to a byte boundary.
	if w.bitLen%8 != 0 {
		w.writeBits(0, 8-(w.bitLen%8))
	}

	// Pad codewords, alternating 0xEC / 0x11, until capacity is filled.
	pad := []byte{0xEC, 0x11}
	i := 0
	for w.bitLen < capacityBits {
		w.writeBits(int(pad[i%2]), 8)
		i++
	}

	return w.bytes
}

// interleaveBlocks splits dataCodewords into their error-correction blocks
// per the version/level's block spec, computes each block's ECC codewords,
// and returns the final interleaved codeword stream ready to place into the
// matrix (all data codewords interleaved column-wise across blocks, then
// all ECC codewords interleaved the same way).
func interleaveBlocks(dataCodewords []byte, version int, level Level) []byte {
	spec := ecBlockTable[version-1][level]
	eccCount := spec.Total1 - spec.Data1

	type block struct {
		data []byte
		ecc  []byte
	}
	var blocks []block

	offset := 0
	for i := 0; i < spec.NumBlocks1; i++ {
		d := dataCodewords[offset : offset+spec.Data1]
		offset += spec.Data1
		blocks = append(blocks, block{data: d, ecc: rsEncode(d, eccCount)})
	}
	for i := 0; i < spec.NumBlocks2; i++ {
		d := dataCodewords[offset : offset+spec.Data2]
		offset += spec.Data2
		blocks = append(blocks, block{data: d, ecc: rsEncode(d, eccCount)})
	}

	var out []byte

	maxData := spec.Data1
	if spec.Data2 > maxData {
		maxData = spec.Data2
	}
	for i := 0; i < maxData; i++ {
		for _, b := range blocks {
			if i < len(b.data) {
				out = append(out, b.data[i])
			}
		}
	}
	for i := 0; i < eccCount; i++ {
		for _, b := range blocks {
			out = append(out, b.ecc[i])
		}
	}

	return out
}
