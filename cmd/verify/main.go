package main

import (
	"bufio"
	"fmt"
	"os"

	"qrbit/internal/qrcode"
)

// Dev-only cross-verification helper: encodes data at a forced mask so the
// output can be diffed byte-for-byte against a reference implementation.
// Not part of the shipped product.
func main() {
	data := os.Args[1]
	var level qrcode.Level
	switch os.Args[2] {
	case "L":
		level = qrcode.LevelL
	case "M":
		level = qrcode.LevelM
	case "Q":
		level = qrcode.LevelQ
	case "H":
		level = qrcode.LevelH
	}

	code, err := qrcode.EncodeWithMask([]byte(data), level, mustAtoi(os.Args[3]))
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	fmt.Fprintln(w, "version", code.Version, "size", code.Size, "mask", code.Mask)
	for _, row := range code.Modules {
		for _, d := range row {
			if d {
				w.WriteByte('1')
			} else {
				w.WriteByte('0')
			}
		}
		w.WriteByte('\n')
	}
}

func mustAtoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
