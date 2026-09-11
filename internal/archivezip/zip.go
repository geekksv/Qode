// Package archivezip bundles named byte blobs into an in-memory ZIP archive
// (stdlib archive/zip), for the Bulk page's "download all as .zip" feature.
package archivezip

import (
	"archive/zip"
	"bytes"
)

type Entry struct {
	Name string
	Data []byte
}

// Build returns the bytes of a ZIP archive containing all entries.
func Build(entries []Entry) ([]byte, error) {
	buf := new(bytes.Buffer)
	w := zip.NewWriter(buf)
	for _, e := range entries {
		f, err := w.Create(e.Name)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write(e.Data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
