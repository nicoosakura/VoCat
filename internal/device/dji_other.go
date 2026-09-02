//go:build !linux

package device

import "context"

func repairDJIQMI(context.Context) (QMIRepairResult, error) {
	return QMIRepairResult{}, ErrDJIRepairUnsupported
}