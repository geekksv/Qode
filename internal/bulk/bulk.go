// Package bulk parses CSV input for batch QR generation. It expects a
// header row; the first column is the data to encode, an optional second
// column is used as a human-readable label/filename for that row.
package bulk

import (
	"encoding/csv"
	"strings"
)

type Row struct {
	Label string
	Data  string
}

// ParseCSV reads CSV text and returns one Row per data row (header skipped).
// Blank lines and rows with an empty first column are skipped.
func ParseCSV(csvText string) ([]Row, error) {
	r := csv.NewReader(strings.NewReader(csvText))
	r.FieldsPerRecord = -1 // tolerate ragged rows
	r.TrimLeadingSpace = true

	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}

	var rows []Row
	for i, rec := range records {
		if i == 0 {
			continue // header
		}
		if len(rec) == 0 || strings.TrimSpace(rec[0]) == "" {
			continue
		}
		data := strings.TrimSpace(rec[0])
		label := data
		if len(rec) > 1 && strings.TrimSpace(rec[1]) != "" {
			label = strings.TrimSpace(rec[1])
		}
		rows = append(rows, Row{Label: label, Data: data})
	}
	return rows, nil
}
