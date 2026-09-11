package qrcode

import "testing"

// Regression fixtures captured from output that was cross-verified module-
// for-module against the Python `qrcode` reference implementation (forced
// byte mode, forced mask) across 80 combinations of data length, version,
// error-correction level and mask -- see cross_verify.py in the repo root
// (dev-only, not part of the build) for how these were produced/checked.

func gridToStrings(modules [][]bool) []string {
	out := make([]string, len(modules))
	for i, row := range modules {
		b := make([]byte, len(row))
		for j, d := range row {
			if d {
				b[j] = '1'
			} else {
				b[j] = '0'
			}
		}
		out[i] = string(b)
	}
	return out
}

func assertGrid(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("size mismatch: got %d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d mismatch: got %s want %s", i, got[i], want[i])
		}
	}
}

var goldenV2M0 = []string{
		"1111111000001111101111111",
		"1000001010100011001000001",
		"1011101001000000101011101",
		"1011101000010011101011101",
		"1011101011000111001011101",
		"1000001001011101001000001",
		"1111111010101010101111111",
		"0000000000000101000000000",
		"1010101001110100000010010",
		"1100000000001100101000001",
		"0011111000000000001110111",
		"1001000111101111011100010",
		"0001111001011100111101011",
		"0000100101111000111001001",
		"1010111101111000101100111",
		"0101100000001100111010010",
		"1001101011010101111111000",
		"0000000011010001100011011",
		"1111111000100001101011011",
		"1000001001110101100011001",
		"1011101010001100111111011",
		"1011101000011001000111100",
		"1011101010111101100010001",
		"1000001000001110111011010",
		"1111111010111011111100011",
	}

func TestEncodeWithMask_GoldenV2LevelMMask0(t *testing.T) {
	code, err := EncodeWithMask([]byte("https://qrbit.app/hello"), LevelM, 0)
	if err != nil {
		t.Fatal(err)
	}
	if code.Version != 2 {
		t.Fatalf("version = %d, want 2", code.Version)
	}
	assertGrid(t, gridToStrings(code.Modules), goldenV2M0)
}

var goldenV1L3 = []string{
		"111111101100101111111",
		"100000100100101000001",
		"101110101010101011101",
		"101110101001001011101",
		"101110101110001011101",
		"100000100000001000001",
		"111111101010101111111",
		"000000000110000000000",
		"111100101010010011101",
		"101001000010100100001",
		"111100111110111110011",
		"001011000110110000010",
		"101011100101010010101",
		"000000001110010100100",
		"111111100110011010100",
		"100000100111111001001",
		"101110100111001001001",
		"101110101010010010010",
		"101110101001010011100",
		"100000101001101011001",
		"111111101001100101000",
	}

func TestEncodeWithMask_GoldenV1LevelLMask3(t *testing.T) {
	code, err := EncodeWithMask([]byte("hi"), LevelL, 3)
	if err != nil {
		t.Fatal(err)
	}
	if code.Version != 1 {
		t.Fatalf("version = %d, want 1", code.Version)
	}
	assertGrid(t, gridToStrings(code.Modules), goldenV1L3)
}

func TestEncode_AutoMaskProducesValidFinderPatterns(t *testing.T) {
	for _, level := range []Level{LevelL, LevelM, LevelQ, LevelH} {
		code, err := Encode([]byte("https://qrbit.app/r#abc123"), level)
		if err != nil {
			t.Fatal(err)
		}
		if code.Mask < 0 || code.Mask > 7 {
			t.Fatalf("invalid chosen mask %d", code.Mask)
		}
		// Top-left finder pattern's outer ring must be fully dark.
		for i := 0; i < 7; i++ {
			if !code.Modules[0][i] || !code.Modules[i][0] {
				t.Fatalf("level %v: top-left finder ring broken at %d", level, i)
			}
		}
	}
}

func TestChooseVersion_TooLong(t *testing.T) {
	huge := make([]byte, 4000)
	_, err := Encode(huge, LevelH)
	if err != ErrTooLong {
		t.Fatalf("err = %v, want ErrTooLong", err)
	}
}
