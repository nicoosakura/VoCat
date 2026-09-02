//go:build linux

package main

import (
	"context"

	"vocat/internal/device"
)

func repairDJIQMI(ctx context.Context) (device.QMIRepairResult, error) {
	return device.RepairDJIQMI(ctx)
}