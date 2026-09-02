//go:build !linux

package device

import "context"

func repairDJIQMI(context.Context) (QMIRepairResult, error) {
	return QMIRepairResult{}, ErrDJIRepairUnsupported
}

func repairDJIQMIFor(context.Context, string) (QMIRepairResult, error) {
	return QMIRepairResult{}, ErrDJIRepairUnsupported
}

func djiTopology(string, string) (DJIUSBTopology, error) {
	return DJIUSBTopology{}, ErrDJITopologyUnsupported
}
