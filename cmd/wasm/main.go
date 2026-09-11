//go:build js && wasm

// Command wasm is QRBit's entire "backend": compiled to WebAssembly and run
// entirely in the browser, it exposes QR encoding, base64url helpers, CSV
// bulk parsing and ZIP bundling to the page's JavaScript via syscall/js.
// Nothing here ever talks to a server -- see web/js/app.js for the caller.
package main

import (
	"encoding/base64"
	"syscall/js"

	"qrbit/internal/archivezip"
	"qrbit/internal/bulk"
	"qrbit/internal/qrcode"
)

func levelFromString(s string) qrcode.Level {
	switch s {
	case "L":
		return qrcode.LevelL
	case "Q":
		return qrcode.LevelQ
	case "H":
		return qrcode.LevelH
	default:
		return qrcode.LevelM
	}
}

// codeToJS converts an encoded QR code into a plain JS object with the
// module grid flattened row-major into a Uint8Array (1 = dark, 0 = light),
// which the JS renderer reshapes using `size`.
func codeToJS(code *qrcode.Code) js.Value {
	flat := make([]byte, code.Size*code.Size)
	for y, row := range code.Modules {
		for x, dark := range row {
			if dark {
				flat[y*code.Size+x] = 1
			}
		}
	}
	jsArr := js.Global().Get("Uint8Array").New(len(flat))
	js.CopyBytesToJS(jsArr, flat)

	obj := js.Global().Get("Object").New()
	obj.Set("ok", true)
	obj.Set("version", code.Version)
	obj.Set("size", code.Size)
	obj.Set("mask", code.Mask)
	obj.Set("modules", jsArr)
	return obj
}

func errJS(err error) js.Value {
	obj := js.Global().Get("Object").New()
	obj.Set("ok", false)
	obj.Set("error", err.Error())
	return obj
}

// qrbitGenerate(data string, level string) -> {ok, version, size, mask, modules} | {ok:false, error}
func qrbitGenerate(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errJS(errString("qrbitGenerate: missing data argument"))
	}
	data := args[0].String()
	level := "M"
	if len(args) > 1 {
		level = args[1].String()
	}
	code, err := qrcode.Encode([]byte(data), levelFromString(level))
	if err != nil {
		return errJS(err)
	}
	return codeToJS(code)
}

// qrbitBase64UrlEncode(s string) -> string
func qrbitBase64UrlEncode(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(args[0].String()))
}

// qrbitBulkGenerate(csvText string, level string) -> {ok, rows:[{label,version,size,mask,modules}]} | {ok:false,error}
func qrbitBulkGenerate(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errJS(errString("qrbitBulkGenerate: missing csvText argument"))
	}
	csvText := args[0].String()
	level := "M"
	if len(args) > 1 {
		level = args[1].String()
	}

	rows, err := bulk.ParseCSV(csvText)
	if err != nil {
		return errJS(err)
	}

	jsRows := js.Global().Get("Array").New(len(rows))
	for i, r := range rows {
		code, err := qrcode.Encode([]byte(r.Data), levelFromString(level))
		entry := js.Global().Get("Object").New()
		entry.Set("label", r.Label)
		entry.Set("data", r.Data)
		if err != nil {
			entry.Set("ok", false)
			entry.Set("error", err.Error())
		} else {
			entry.Set("ok", true)
			flat := make([]byte, code.Size*code.Size)
			for y, row := range code.Modules {
				for x, dark := range row {
					if dark {
						flat[y*code.Size+x] = 1
					}
				}
			}
			jsArr := js.Global().Get("Uint8Array").New(len(flat))
			js.CopyBytesToJS(jsArr, flat)
			entry.Set("version", code.Version)
			entry.Set("size", code.Size)
			entry.Set("mask", code.Mask)
			entry.Set("modules", jsArr)
		}
		jsRows.SetIndex(i, entry)
	}

	out := js.Global().Get("Object").New()
	out.Set("ok", true)
	out.Set("rows", jsRows)
	out.Set("count", len(rows))
	return out
}

// qrbitZip(entries: [{name: string, bytes: Uint8Array}]) -> Uint8Array (zip bytes) | null on error
func qrbitZip(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return js.Null()
	}
	jsEntries := args[0]
	n := jsEntries.Length()
	entries := make([]archivezip.Entry, n)
	for i := 0; i < n; i++ {
		item := jsEntries.Index(i)
		name := item.Get("name").String()
		jsBytes := item.Get("bytes")
		data := make([]byte, jsBytes.Get("length").Int())
		js.CopyBytesToGo(data, jsBytes)
		entries[i] = archivezip.Entry{Name: name, Data: data}
	}

	zipBytes, err := archivezip.Build(entries)
	if err != nil {
		return js.Null()
	}
	out := js.Global().Get("Uint8Array").New(len(zipBytes))
	js.CopyBytesToJS(out, zipBytes)
	return out
}

type simpleErr string

func (e simpleErr) Error() string { return string(e) }
func errString(s string) error    { return simpleErr(s) }

func main() {
	c := make(chan struct{})

	js.Global().Set("qrbitGenerate", js.FuncOf(qrbitGenerate))
	js.Global().Set("qrbitBase64UrlEncode", js.FuncOf(qrbitBase64UrlEncode))
	js.Global().Set("qrbitBulkGenerate", js.FuncOf(qrbitBulkGenerate))
	js.Global().Set("qrbitZip", js.FuncOf(qrbitZip))
	js.Global().Set("qrbitReady", js.ValueOf(true))
	if fn := js.Global().Get("qrbitOnReady"); fn.Type() == js.TypeFunction {
		fn.Invoke()
	}

	<-c // keep the Go runtime alive so the exported funcs stay callable
}
