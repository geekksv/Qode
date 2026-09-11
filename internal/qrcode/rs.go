package qrcode

// Reed-Solomon error correction over GF(256), using the field used by QR
// codes: primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D), generator 2.

var gfExp [512]byte
var gfLog [256]byte

func init() {
	x := 1
	for i := 0; i < 255; i++ {
		gfExp[i] = byte(x)
		gfLog[x] = byte(i)
		x <<= 1
		if x&0x100 != 0 {
			x ^= 0x11D
		}
	}
	for i := 255; i < 512; i++ {
		gfExp[i] = gfExp[i-255]
	}
}

func gfMul(a, b byte) byte {
	if a == 0 || b == 0 {
		return 0
	}
	return gfExp[int(gfLog[a])+int(gfLog[b])]
}

// rsGeneratorPoly returns the generator polynomial (coefficients, highest
// degree first, monic) for `degree` ECC codewords.
func rsGeneratorPoly(degree int) []byte {
	poly := []byte{1}
	for i := 0; i < degree; i++ {
		// multiply poly by (x - 2^i) == (x + 2^i) in GF(2^8)
		next := make([]byte, len(poly)+1)
		root := gfExp[i]
		for j, coef := range poly {
			next[j] ^= coef
			next[j+1] ^= gfMul(coef, root)
		}
		poly = next
	}
	return poly
}

// rsEncode computes the ECC codewords for a block of data codewords.
func rsEncode(data []byte, eccCount int) []byte {
	gen := rsGeneratorPoly(eccCount)
	remainder := make([]byte, len(data)+eccCount)
	copy(remainder, data)
	for i := 0; i < len(data); i++ {
		coef := remainder[i]
		if coef == 0 {
			continue
		}
		for j, g := range gen {
			remainder[i+j] ^= gfMul(g, coef)
		}
	}
	return remainder[len(data):]
}
