package device

import "testing"

func TestParseDJITemperature(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  float64
		ok    bool
	}{
		{
			name:  "single sensor pair",
			lines: []string{"+QTEMP: 0,35", "OK"},
			want:  35,
			ok:    true,
		},
		{
			name:  "multi sensor pairs",
			lines: []string{"+QTEMP: 0,35", "+QTEMP: 1,42", "OK"},
			want:  35,
			ok:    true,
		},
		{
			name:  "bare readings",
			lines: []string{"+QTEMP: 45,42,38", "OK"},
			want:  45,
			ok:    true,
		},
		{
			name:  "single bare reading",
			lines: []string{"+QTEMP: 38", "OK"},
			want:  38,
			ok:    true,
		},
		{
			name:  "spaced separator",
			lines: []string{"+QTEMP: 0 41", "OK"},
			want:  41,
			ok:    true,
		},
		{
			name:  "sensor not ready skipped",
			lines: []string{"+QTEMP: 0,0", "OK"},
			want:  0,
			ok:    false,
		},
		{
			name:  "garbage ignored",
			lines: []string{"ERROR", "+QCFG: \"usbnet\",0", "OK"},
			want:  0,
			ok:    false,
		},
		{
			name:  "unsupported command echo only",
			lines: []string{"AT+QTEMP", "ERROR"},
			want:  0,
			ok:    false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ParseDJITemperature(test.lines)
			if ok != test.ok || (ok && got != test.want) {
				t.Fatalf("ParseDJITemperature(%q) = %v, %v; want %v, %v", test.lines, got, ok, test.want, test.ok)
			}
		})
	}
}